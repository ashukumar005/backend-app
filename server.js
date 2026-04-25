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

    const bookingDoc = await db.collection("bookings").doc(bookingId).get();

    if (!bookingDoc.exists) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const booking = bookingDoc.data();

    if (type === "advance" && booking.advancePaid) {
      return res.status(400).json({ error: "Advance already paid" });
    }

    if (type === "final" && booking.finalPaid) {
      return res.status(400).json({ error: "Final already paid" });
    }

    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: "INR",
    });

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

    const generated_signature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(order_id + "|" + payment_id)
      .digest("hex");

    if (generated_signature !== signature) {
      return res.json({ success: false });
    }

    const paymentRef = db.collection("payments").doc(order_id);
    const paymentDoc = await paymentRef.get();
    const payment = paymentDoc.data();

    const bookingRef = db.collection("bookings").doc(bookingId);
    const bookingDoc = await bookingRef.get();
    const booking = bookingDoc.data();

    await paymentRef.update({
      paymentId: payment_id,
      status: "success",
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    ////////////////////////////////////////////////////////////
    /// ADVANCE PAYMENT
    ////////////////////////////////////////////////////////////

    if (payment.type === "advance") {
      await bookingRef.update({
        advancePaid: true,
        status: "advance_paid",
      });
    }

    ////////////////////////////////////////////////////////////
    /// FINAL PAYMENT
    ////////////////////////////////////////////////////////////

    if (payment.type === "final") {
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
/// 💰 WITHDRAW (PRODUCTION SAFE)
////////////////////////////////////////////////////////////

app.post("/withdraw", async (req, res) => {
  try {
    const { providerId, amount } = req.body;

    if (!providerId || !amount) {
      return res.status(400).json({
        success: false,
        message: "providerId and amount required",
      });
    }

    if (amount <= 0 || amount < 100) {
      return res.json({
        success: false,
        message: "Minimum ₹100 required",
      });
    }

    const providerRef = db.collection("providers").doc(providerId);

    await db.runTransaction(async (t) => {
      const doc = await t.get(providerRef);

      if (!doc.exists) throw new Error("Provider not found");

      const data = doc.data();
      const wallet = data.wallet || 0;

      if (amount > wallet) {
        throw new Error("Insufficient balance");
      }

      ////////////////////////////////////////////////////////////
      /// WALLET DEDUCT
      ////////////////////////////////////////////////////////////

      t.update(providerRef, {
        wallet: admin.firestore.FieldValue.increment(-amount),
      });

      ////////////////////////////////////////////////////////////
      /// CREATE WITHDRAW ENTRY
      ////////////////////////////////////////////////////////////

      const withdrawRef = db.collection("withdrawals").doc();

      t.set(withdrawRef, {
        providerId,
        amount,
        status: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        processedAt: null,
        method: "upi",
        upi: data.upi || null,
      });
    });

    res.json({
      success: true,
      message: "Withdraw request created",
    });
  } catch (error) {
    console.log("WITHDRAW ERROR:", error);
    res.json({
      success: false,
      message: error.message || "Withdraw failed",
    });
  }
});

////////////////////////////////////////////////////////////
/// 🚀 SERVER
////////////////////////////////////////////////////////////

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} 🚀`);
});