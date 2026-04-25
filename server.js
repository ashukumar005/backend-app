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
/// 🔥 FIREBASE
////////////////////////////////////////////////////////////

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

////////////////////////////////////////////////////////////
/// 🔑 RAZORPAY
////////////////////////////////////////////////////////////

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

////////////////////////////////////////////////////////////
/// 🧪 TEST
////////////////////////////////////////////////////////////

app.get("/", (req, res) => {
  res.send("Backend running ✅");
});

////////////////////////////////////////////////////////////
/// 💳 CREATE ORDER
////////////////////////////////////////////////////////////

app.post("/create-order", async (req, res) => {
  try {
    const { bookingId, amount, type } = req.body;

    if (!bookingId || !amount || !type) {
      return res.status(400).json({
        error: "bookingId, amount, type required",
      });
    }

    // 🔥 booking fetch
    const bookingDoc = await db.collection("bookings").doc(bookingId).get();

    if (!bookingDoc.exists) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const booking = bookingDoc.data();

    // ❗ duplicate protection
    if (type === "advance" && booking.advancePaid) {
      return res.status(400).json({ error: "Advance already paid" });
    }

    if (type === "final" && booking.finalPaid) {
      return res.status(400).json({ error: "Final already paid" });
    }

    // 🔥 Razorpay order
    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: "INR",
    });

    // 🔥 Save payment
    await db.collection("payments").doc(order.id).set({
      orderId: order.id,
      bookingId,
      userId: booking.customerId,
      providerId: booking.providerId,
      type,
      amount,
      status: "created",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json(order);
  } catch (error) {
    console.log("CREATE ORDER ERROR:", error);
    res.status(500).send("Error creating order");
  }
});

////////////////////////////////////////////////////////////
/// 🔐 VERIFY PAYMENT
////////////////////////////////////////////////////////////

app.post("/verify-payment", async (req, res) => {
  try {
    const { order_id, payment_id, signature, bookingId } = req.body;

    if (!bookingId) {
      return res.status(400).json({ error: "BookingId required" });
    }

    // 🔐 verify signature
    const generated_signature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(order_id + "|" + payment_id)
      .digest("hex");

    if (generated_signature !== signature) {
      return res.json({ success: false });
    }

    ////////////////////////////////////////////////////////////
    /// 🔥 GET PAYMENT + BOOKING
    ////////////////////////////////////////////////////////////

    const paymentRef = db.collection("payments").doc(order_id);
    const paymentDoc = await paymentRef.get();
    const payment = paymentDoc.data();

    const bookingRef = db.collection("bookings").doc(bookingId);
    const bookingDoc = await bookingRef.get();
    const booking = bookingDoc.data();

    ////////////////////////////////////////////////////////////
    /// 🔥 UPDATE PAYMENT
    ////////////////////////////////////////////////////////////

    await paymentRef.update({
      paymentId: payment_id,
      status: "success",
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    ////////////////////////////////////////////////////////////
    /// 🔥 ADVANCE PAYMENT
    ////////////////////////////////////////////////////////////

    if (payment.type === "advance") {
      await bookingRef.update({
        advancePaid: true,
        status: "advance_paid",
      });
    }

    ////////////////////////////////////////////////////////////
    /// 🔥 FINAL PAYMENT
    ////////////////////////////////////////////////////////////

    if (payment.type === "final") {
      // 💰 wallet update only once
      if (!booking.isCounted) {
        const commission = booking.totalPrice * 0.1;
        const providerAmount = booking.totalPrice - commission;

        await db.collection("providers").doc(booking.providerId).update({
          wallet: admin.firestore.FieldValue.increment(providerAmount),
          totalJobs: admin.firestore.FieldValue.increment(1),
          totalEarnings: admin.firestore.FieldValue.increment(providerAmount),
        });

        await bookingRef.update({
          isCounted: true,
        });
      }

      await bookingRef.update({
        finalPaid: true,
        status: "completed",
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.log("VERIFY ERROR:", error);
    res.status(500).send("Verification error");
  }
});

////////////////////////////////////////////////////////////
/// 💰 WITHDRAW
////////////////////////////////////////////////////////////

app.post("/withdraw", async (req, res) => {
  try {
    const { providerId, amount } = req.body;

    const providerRef = db.collection("providers").doc(providerId);
    const providerDoc = await providerRef.get();

    const wallet = providerDoc.data().wallet || 0;

    if (wallet < amount) {
      return res.json({
        success: false,
        message: "Insufficient balance",
      });
    }

    await providerRef.update({
      wallet: admin.firestore.FieldValue.increment(-amount),
    });

    await db.collection("withdrawals").add({
      providerId,
      amount,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true });
  } catch (error) {
    console.log("WITHDRAW ERROR:", error);
    res.status(500).send("Withdraw error");
  }
});

////////////////////////////////////////////////////////////
/// 🚀 SERVER
////////////////////////////////////////////////////////////

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} 🚀`);
});