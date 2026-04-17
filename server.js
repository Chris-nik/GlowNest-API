// ==========================================
// GLOWNEST BACKEND - CORE API & AUTO-SYNC
// ==========================================

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const app = express();
app.use(cors());
app.use(express.json());

// 1. DATABASE CONNECTIVITY
const MONGODB_URI = process.env.MONGODB_URI;

mongoose.connect(MONGODB_URI)
    .then(() => {
        console.log("✅ DATABASE STATUS: CONNECTED TO CLOUD");
        
        const PORT = process.env.PORT || 10000;
        app.listen(PORT, () => {
            console.log(`🚀 GLOWNEST SERVER ACTIVE ON PORT ${PORT}`);
            syncOrderStatuses();
            syncServices();
        });
    })
    .catch(err => {
        console.log("❌ DATABASE STATUS: FAILED", err);
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
    referredBy: { type: String, default: null }
});
const User = mongoose.model('User', userSchema);

const serviceSchema = new mongoose.Schema({
    serviceId: { type: String, unique: true },
    name: String,
    category: String,
    price: Number,
    min: Number,
    max: Number
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
    date: { type: Date, default: Date.now }
});
const Order = mongoose.model('Order', orderSchema);

// ------------------------------------------
// 3. API CONFIGURATION & SYNC LOGIC
// ------------------------------------------
const SHWEBOOST_API = "https://shweboost.com/api/v2";
const MY_API_KEY = process.env.SHWEBOOST_API_KEY || "b9add3c4b63fb0e7cc7a01362f8eb69d";

async function syncOrderStatuses() {
    try {
        const activeOrders = await Order.find({ 
            status: { $in: ['Pending', 'In Progress', 'Processing', 'Partial'] } 
        });
        for (let order of activeOrders) {
            const response = await axios.post(SHWEBOOST_API, null, {
                params: { key: MY_API_KEY, action: 'status', order: order.shweOrderId }
            });
            if (response.data && response.data.status) {
                const newStatus = response.data.status;
                if (order.status !== newStatus) {
                    await Order.updateOne({ _id: order._id }, { status: newStatus });
                }
            }
        }
    } catch (err) { console.log("❌ Status Sync Error:", err.message); }
}

async function syncServices() {
    try {
        const response = await axios.post(SHWEBOOST_API, null, {
            params: { key: MY_API_KEY, action: 'services' }
        });
        
        if (Array.isArray(response.data)) {
            const ADJUSTED_EXCHANGE = 3500; 
            const PROFIT_PERCENT = 1.20; 

            for (let s of response.data) {
                const usdRate = parseFloat(s.rate);
                const rawPrice = usdRate * ADJUSTED_EXCHANGE * PROFIT_PERCENT;
                const finalPrice = Math.ceil(rawPrice); 

                await Service.findOneAndUpdate(
                    { serviceId: s.service },
                    { 
                        name: s.name, 
                        category: s.category, 
                        price: finalPrice,
                        min: s.min,
                        max: s.max
                    },
                    { upsert: true }
                );
            }
            console.log("✅ Sync Complete: Services Updated.");
        }
    } catch (err) { console.log("❌ Service Sync Error: " + err.message); }
}

setInterval(syncOrderStatuses, 600000);
setInterval(syncServices, 3600000);

// ------------------------------------------
// 4. ROUTES
// ------------------------------------------
app.get('/api/services', async (req, res) => {
    try {
        const localData = await Service.find().sort({ category: 1 });
        res.json(localData);
    } catch (err) { res.status(500).json([]); }
});

app.post('/api/signup', async (req, res) => {
    const { email, password, ref } = req.body;
    try {
        const existingUser = await User.findOne({ email });
        if (existingUser) return res.json({ success: false, error: "User exists" });

        const hashedPassword = await bcrypt.hash(password, 10);
        const myRefCode = "REF" + Math.random().toString(36).substring(2, 8).toUpperCase();
        
        const newUser = new User({ 
            email, 
            password: hashedPassword, 
            balance: 0,
            referralCode: myRefCode,
            referredBy: ref || null
        });

        await newUser.save();

        if (ref) {
            await User.updateOne(
                { referralCode: ref },
                { $inc: { referralBalance: 50 } }
            );
        }

        res.json({ success: true, user: { email, balance: 0, referralCode: myRefCode } });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/signin', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await User.findOne({ email });
        if (!user) return res.json({ success: false, error: "User not found" });
        const isMatch = await bcrypt.compare(password, user.password);
        if (isMatch) {
            res.json({ success: true, user: { 
                email: user.email, 
                balance: user.balance, 
                referralCode: user.referralCode,
                referralBalance: user.referralBalance 
            } });
        } else res.json({ success: false, error: "Wrong password" });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.get('/api/user/:email', async (req, res) => {
    try {
        const user = await User.findOne({ email: req.params.email });
        if (user) res.json({ 
            success: true, 
            balance: user.balance, 
            spent: user.spent,
            referralCode: user.referralCode,
            referralBalance: user.referralBalance
        });
        else res.json({ success: false });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/referral/claim', async (req, res) => {
    const { email } = req.body;
    try {
        const user = await User.findOne({ email });
        if (!user) return res.json({ success: false, error: "User not found" });
        if (user.referralBalance < 1000) {
            return res.json({ success: false, error: "အနည်းဆုံး ၁၀၀၀ ကျပ်ပြည့်မှ ထည့်သွင်းနိုင်ပါမည်။" });
        }
        user.balance += user.referralBalance;
        user.referralBalance = 0; 
        await user.save();
        res.json({ success: true, newBalance: user.balance });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/order', async (req, res) => {
    const { userEmail, serviceId, serviceName, link, quantity, charge, comments } = req.body;
    const finalCharge = typeof charge === 'string' ? parseFloat(charge.replace(/[^0-9.]/g, '')) : charge;

    try {
        const user = await User.findOne({ email: userEmail });
        if (!user || user.balance < finalCharge) {
            return res.json({ success: false, error: "Insufficient balance!" });
        }

        const apiParams = {
            key: MY_API_KEY,
            action: 'add',
            service: serviceId,
            link: link,
            quantity: quantity
        };

        if (comments && comments.trim() !== "") {
            apiParams.comments = comments.trim();
        }

        const shweResponse = await axios.post(SHWEBOOST_API, null, { params: apiParams });

        if (shweResponse.data && shweResponse.data.order) {
            user.balance -= finalCharge;
            user.spent += finalCharge;
            await user.save();

            const newOrder = new Order({
                userEmail,
                shweOrderId: shweResponse.data.order,
                serviceName,
                link,
                quantity,
                charge: finalCharge
            });
            await newOrder.save();
            res.json({ success: true, orderId: shweResponse.data.order });
        } else {
            res.json({ success: false, error: shweResponse.data.error || "Provider API Error" });
        }
    } catch (err) { 
        console.error("Order process error:", err.message);
        res.json({ success: false, error: "Server connection error" }); 
    }
});

app.get('/api/orders/:email', async (req, res) => {
    try {
        const orders = await Order.find({ userEmail: req.params.email }).sort({ date: -1 });
        res.json({ success: true, orders });
    } catch (err) { res.status(500).json({ success: false }); }
});