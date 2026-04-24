const express = require("express");
const cors = require("cors");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const admin = require("firebase-admin");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

////////////////////////////////////////////////////////////
/// 🔥 FIREBASE ADMIN SETUP
////////////////////////////////////////////////////////////

// 🔥 STEP: Firebase service account JSON download karke yaha add kar
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

////////////////////////////////////////////////////////////
/// 🔑 RAZORPAY SETUP
////////////////////////////////////////////////////////////
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

////////////////////////////////////////////////////////////
/// 🧪 TEST API
////////////////////////////////////////////////////////////
app.get("/", (req, res) => {
  res.send("Backend running ✅");
});

////////////////////////////////////////////////////////////
/// 💳 CREATE ORDER
////////////////////////////////////////////////////////////
app.post("/create-order", async (req, res) => {
  try {
    const { amount, bookingId, userId, providerId } = req.body;

    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: "INR",
    });

    // 🔥 Save order in DB (important)
    await db.collection("payments").doc(order.id).set({
      orderId: order.id,
      bookingId,
      userId,
      providerId,
      amount,
      status: "created",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json(order);
  } catch (error) {
    console.log(error);
    res.status(500).send("Error creating order");
  }
});

////////////////////////////////////////////////////////////
/// 🔐 VERIFY PAYMENT (MAIN LOGIC)
////////////////////////////////////////////////////////////
app.post("/verify-payment", async (req, res) => {
  try {
    const { order_id, payment_id, signature, bookingId } = req.body;

    const generated_signature = crypto
      .createHmac("sha256", "wjDzBvb8M64zci5QE5wl3YLk")
      .update(order_id + "|" + payment_id)
      .digest("hex");

    if (generated_signature === signature) {
      ////////////////////////////////////////////////////////////
      /// ✅ PAYMENT SUCCESS
      ////////////////////////////////////////////////////////////

      // 🔥 Update payment record
      await db.collection("payments").doc(order_id).update({
        paymentId: payment_id,
        status: "success",
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 🔥 Update booking
      await db.collection("bookings").doc(bookingId).update({
        status: "advance_paid",
        paymentId: payment_id,
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      ////////////////////////////////////////////////////////////
      /// 💰 PROVIDER WALLET ADD
      ////////////////////////////////////////////////////////////

      const bookingDoc = await db.collection("bookings").doc(bookingId).get();
      const bookingData = bookingDoc.data();

      const providerId = bookingData.providerId;
      const amount = bookingData.advanceAmount;

      // 🔥 Commission (example 10%)
      const commission = amount * 0.1;
      const providerAmount = amount - commission;

      // 🔥 Add to provider wallet
      await db.collection("providers").doc(providerId).update({
        wallet: admin.firestore.FieldValue.increment(providerAmount),
      });

      res.json({ success: true });
    } else {
      res.json({ success: false });
    }
  } catch (error) {
    console.log(error);
    res.status(500).send("Verification error");
  }
});

////////////////////////////////////////////////////////////
/// 💰 WITHDRAW REQUEST (PROVIDER)
////////////////////////////////////////////////////////////
app.post("/withdraw", async (req, res) => {
  try {
    const { providerId, amount } = req.body;

    const providerRef = db.collection("providers").doc(providerId);
    const providerDoc = await providerRef.get();

    const wallet = providerDoc.data().wallet || 0;

    if (wallet < amount) {
      return res.json({ success: false, message: "Insufficient balance" });
    }

    // 🔥 Deduct wallet
    await providerRef.update({
      wallet: admin.firestore.FieldValue.increment(-amount),
    });

    // 🔥 Create withdrawal request
    await db.collection("withdrawals").add({
      providerId,
      amount,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true });
  } catch (error) {
    console.log(error);
    res.status(500).send("Withdraw error");
  }
});

////////////////////////////////////////////////////////////
/// 🚀 START SERVER
////////////////////////////////////////////////////////////
app.listen(5000, () => {
  console.log("Server running on port 5000 🚀");
});