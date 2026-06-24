// ==========================================
// GLOWNEST BACKEND - DNS & NETWORK FIX
// ==========================================

// FORCE DNS TO GOOGLE TO BYPASS ISP BLOCKS
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const app = express();
app.use(cors());
app.use(express.json());

// ------------------------------------------
// 1. DATABASE CONNECTIVITY
// ------------------------------------------
const MONGODB_URI = process.env.MONGODB_URI;

mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 50000,
    socketTimeoutMS: 50000
})
    .then(() => {
        console.log("✅ DATABASE STATUS: CONNECTED TO CLOUD");
        const PORT = process.env.PORT || 10000;
        app.listen(PORT, () => {
            console.log("🚀 GLOWNEST SERVER ACTIVE ON PORT " + PORT);
            syncOrderStatuses();
            syncServices();
        });
    })
    .catch(err => {
        console.log("❌ DATABASE STATUS: FAILED", err.message);
        process.exit(1);
    });

// ------------------------------------------
// 2. SCHEMAS & MODELS
// ------------------------------------------

const userSchema = new mongoose.Schema({
    email: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 0 },
    spent: { type: Number, default: 0 },
    referralCode: { type: String, unique: true },
    referralBalance: { type: Number, default: 0 },
    referredBy: { type: String, default: null },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const serviceSchema = new mongoose.Schema({
    serviceId: { type: String, unique: true },
    name: String,
    category: String,
    price: Number,
    min: Number,
    max: Number,
    description: String,
    lastUpdated: { type: Date, default: Date.now }
});
const Service = mongoose.model('Service', serviceSchema);

const orderSchema = new mongoose.Schema({
    userEmail: String,
    shweOrderId: String,
    serviceName: String,
    link: String,
    quantity: Number,
    charge: Number,
    status: { type: String, default: 'Pending' },
    refunded: { type: Boolean, default: false },
    date: { type: Date, default: Date.now }
});
const Order = mongoose.model('Order', orderSchema);

const balanceHistorySchema = new mongoose.Schema({
    email: String,
    amount: Number,
    type: { type: String, default: 'Admin Manual Add' },
    date: { type: Date, default: Date.now }
});
const BalanceHistory = mongoose.model('BalanceHistory', balanceHistorySchema);

// ------------------------------------------
// 3. API CONFIGURATION & SYNC LOGIC
// ------------------------------------------
const SHWEBOOST_API = "https://shweboost.com/api/v2";
const MY_API_KEY = process.env.SHWEBOOST_API_KEY || "b9add3c4b63fb0e7cc7a01362f8eb69d"; 

async function syncOrderStatuses() {
    console.log("🔄 Starting Order Status Sync...");
    try {
        const activeOrders = await Order.find({ 
            status: { $in: ['Pending', 'In Progress', 'Processing', 'Partial'] } 
        });
        
        for (let order of activeOrders) {
            try {
                const response = await axios.post(SHWEBOOST_API, null, {
                    params: { key: MY_API_KEY, action: 'status', order: order.shweOrderId }
                });

                if (response.data && response.data.status) {
                    const newStatus = response.data.status;
                    if ((newStatus === 'Canceled' || newStatus === 'Cancelled' || newStatus === 'Fail') && !order.refunded) {
                        await User.updateOne({ email: order.userEmail }, { 
                            $inc: { balance: order.charge, spent: -order.charge } 
                        });
                        await Order.updateOne({ _id: order._id }, { status: newStatus, refunded: true });
                        console.log(`💰 Refunded ${order.charge} MMK to ${order.userEmail}`);
                    } 
                    else if (order.status !== newStatus) {
                        await Order.updateOne({ _id: order._id }, { status: newStatus });
                        console.log(`📦 Order ${order.shweOrderId} updated to ${newStatus}`);
                    }
                }
            } catch (e) { console.log(`Error syncing order ${order.shweOrderId}`); }
        }
    } catch (err) { console.log("❌ Status Sync Fail:", err.message); }
}

async function syncServices() {
    console.log("🔄 Fetching Latest Services from Provider...");
    try {
        const response = await axios.post(SHWEBOOST_API, null, {
            params: { key: MY_API_KEY, action: 'services' }
        });
        
        if (Array.isArray(response.data)) {
            const ADJUSTED_EXCHANGE = 3500; 
            const PROFIT_PERCENT = 1.20; 

            for (let s of response.data) {
                const usdRate = parseFloat(s.rate);
                const finalPrice = Math.ceil(usdRate * ADJUSTED_EXCHANGE * PROFIT_PERCENT); 

                await Service.findOneAndUpdate(
                    { serviceId: s.service },
                    { 
                        name: s.name, 
                        category: s.category, 
                        price: finalPrice,
                        min: s.min,
                        max: s.max,
                        description: s.desc,
                        lastUpdated: Date.now()
                    },
                    { upsert: true }
                );
            }
            console.log("✅ Service Database Updated.");
        }
    } catch (err) { console.log("❌ Service Sync Fail: " + err.message); }
}

setInterval(syncOrderStatuses, 600000); 
setInterval(syncServices, 3600000);    

// ------------------------------------------
// 4. ADMIN ROUTES
// ------------------------------------------

app.post('/api/admin/add-balance', async (req, res) => {
    const { email, amount, adminPassword } = req.body;
    if (adminPassword !== "2791126SP") return res.json({ success: false, error: "Access Denied" });

    try {
        const user = await User.findOneAndUpdate(
            { email }, 
            { $inc: { balance: parseFloat(amount) } }, 
            { new: true }
        );
        if (!user) return res.json({ success: false, error: "User not found" });
        const log = new BalanceHistory({ email, amount: parseFloat(amount) });
        await log.save();
        res.json({ success: true, newBalance: user.balance });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.get('/api/admin/balance-history', async (req, res) => {
    try {
        const logs = await BalanceHistory.find().sort({ date: -1 }).limit(100);
        res.json({ success: true, history: logs });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.get('/api/admin/total-orders', async (req, res) => {
    try {
        const total = await Order.countDocuments();
        res.json({ success: true, total });
    } catch (err) { res.json({ success: true, total: 0 }); }
});

// ------------------------------------------
// 5. USER & STORE ROUTES
// ------------------------------------------

app.post('/api/signup', async (req, res) => {
    const { email, password, ref } = req.body;
    try {
        const check = await User.findOne({ email });
        if (check) return res.json({ success: false, error: "Email already registered" });
        const hashed = await bcrypt.hash(password, 10);
        const myRef = "REF" + Math.random().toString(36).substring(2, 8).toUpperCase();
        const newUser = new User({ email, password: hashed, referralCode: myRef, referredBy: ref || null });
        await newUser.save();
        if (ref) { await User.updateOne({ referralCode: ref }, { $inc: { referralBalance: 50 } }); }
        res.json({ success: true, user: { email, balance: 0, referralCode: myRef } });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/signin', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await User.findOne({ email });
        if (!user) return res.json({ success: false, error: "User not found" });
        const match = await bcrypt.compare(password, user.password);
        if (match) {
            res.json({ success: true, user: { email: user.email, balance: user.balance, referralCode: user.referralCode, referralBalance: user.referralBalance } });
        } else res.json({ success: false, error: "Invalid credentials" });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.get('/api/user/:email', async (req, res) => {
    try {
        const user = await User.findOne({ email: req.params.email });
        if (user) res.json({ success: true, balance: user.balance, spent: user.spent, referralCode: user.referralCode, referralBalance: user.referralBalance });
        else res.json({ success: false });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/user/update-password', async (req, res) => {
    const { email, password } = req.body;
    try {
        const hashed = await bcrypt.hash(password, 10);
        const user = await User.findOneAndUpdate({ email }, { password: hashed });
        if (user) res.json({ success: true });
        else res.json({ success: false, error: "User profile context not found" });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.get('/api/services', async (req, res) => {
    try {
        const data = await Service.find().sort({ category: 1 });
        res.json(data);
    } catch (err) { res.json([]); }
});

app.post('/api/order', async (req, res) => {
    const { userEmail, serviceId, serviceName, link, quantity, charge, comments } = req.body;
    let cost = typeof charge === 'string' ? parseFloat(charge.replace(/[^0-9.]/g, '')) : charge;
    try {
        const user = await User.findOne({ email: userEmail });
        if (!user) return res.json({ success: false, error: "User portfolio session identity missing" });
        
        // Backend recalculation validation with automated 10% VIP tier enforcement
        const targetService = await Service.findOne({ serviceId });
        if (targetService) {
            let baseCost = (targetService.price / 1000) * quantity;
            if (user.spent >= 50000) {
                baseCost = baseCost * 0.90; // Apply a 10% markdown discount for VIP spend patterns
            }
            cost = Math.ceil(baseCost);
        }

        if (user.balance < cost) return res.json({ success: false, error: "Insufficient Balance" });
        const params = { key: MY_API_KEY, action: 'add', service: serviceId, link, quantity };
        if (comments) params.comments = comments.trim();
        const providerRes = await axios.post(SHWEBOOST_API, null, { params });
        if (providerRes.data && providerRes.data.order) {
            user.balance -= cost; user.spent += cost; await user.save();
            const newOrder = new Order({ userEmail, shweOrderId: providerRes.data.order, serviceName, link, quantity, charge: cost });
            await newOrder.save();
            res.json({ success: true, orderId: providerRes.data.order });
        } else { res.json({ success: false, error: providerRes.data.error || "Provider Busy" }); }
    } catch (err) { res.json({ success: false, error: "Network Error" }); }
});

app.get('/api/orders/:email', async (req, res) => {
    try {
        const list = await Order.find({ userEmail: req.params.email }).sort({ date: -1 });
        res.json({ success: true, orders: list });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/referral/claim', async (req, res) => {
    const { email } = req.body;
    try {
        const user = await User.findOne({ email });
        if (!user) return res.json({ success: false });
        if (user.referralBalance < 1000) return res.json({ success: false, error: "Min 1000 MMK" });
        user.balance += user.referralBalance; user.referralBalance = 0; await user.save();
        res.json({ success: true, newBalance: user.balance });
    } catch (err) { res.status(500).json({ success: false }); }
});