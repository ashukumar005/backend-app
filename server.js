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

const serviceAccount = JSON.parse(
  process.env.FIREBASE_KEY
);

admin.initializeApp({
  credential: admin.credential.cert(
    serviceAccount
  ),
});

const db = admin.firestore();

////////////////////////////////////////////////////////////
/// 🔑 RAZORPAY
////////////////////////////////////////////////////////////

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret:
    process.env.RAZORPAY_KEY_SECRET,
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
    const { bookingId, amount, type } =
      req.body;

    ////////////////////////////////////////////////////////////
    /// VALIDATION
    ////////////////////////////////////////////////////////////

    if (
      !bookingId ||
      !amount ||
      !type
    ) {
      return res.status(400).json({
        success: false,
        message:
          "bookingId, amount, type required",
      });
    }

    ////////////////////////////////////////////////////////////
    /// FETCH BOOKING
    ////////////////////////////////////////////////////////////

    const bookingRef = db
      .collection("bookings")
      .doc(bookingId);

    const bookingDoc =
      await bookingRef.get();

    if (!bookingDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }

    const booking = bookingDoc.data();

    ////////////////////////////////////////////////////////////
    /// DUPLICATE CHECK
    ////////////////////////////////////////////////////////////

    if (
      type === "advance" &&
      booking.advancePaid
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Advance already paid",
      });
    }

    if (
      type === "final" &&
      booking.finalPaid
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Final already paid",
      });
    }

    ////////////////////////////////////////////////////////////
    /// CREATE RAZORPAY ORDER
    ////////////////////////////////////////////////////////////

    const order =
      await razorpay.orders.create({
        amount: amount * 100,
        currency: "INR",
      });

    ////////////////////////////////////////////////////////////
    /// SAVE PAYMENT
    ////////////////////////////////////////////////////////////

    await db
      .collection("payments")
      .doc(order.id)
      .set({
        orderId: order.id,
        bookingId,
        userId:
          booking.customerId,
        providerId:
          booking.providerId,
        type,
        amount,
        status: "created",
        createdAt:
          admin.firestore.FieldValue.serverTimestamp(),
      });

    ////////////////////////////////////////////////////////////
    /// RESPONSE
    ////////////////////////////////////////////////////////////

    res.json(order);

  } catch (error) {
    console.log(
      "CREATE ORDER ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      message:
        error.message ||
        "Create order failed",
    });
  }
});

////////////////////////////////////////////////////////////
/// 🔐 VERIFY PAYMENT
////////////////////////////////////////////////////////////

app.post(
  "/verify-payment",
  async (req, res) => {
    try {
      const {
        order_id,
        payment_id,
        signature,
        bookingId,
      } = req.body;

      ////////////////////////////////////////////////////////////
      /// VERIFY SIGNATURE
      ////////////////////////////////////////////////////////////

      const generatedSignature =
        crypto
          .createHmac(
            "sha256",
            process.env
              .RAZORPAY_KEY_SECRET
          )
          .update(
            order_id + "|" + payment_id
          )
          .digest("hex");

      if (
        generatedSignature !==
        signature
      ) {
        return res.json({
          success: false,
          message:
            "Invalid signature",
        });
      }

      ////////////////////////////////////////////////////////////
      /// FETCH PAYMENT
      ////////////////////////////////////////////////////////////

      const paymentRef = db
        .collection("payments")
        .doc(order_id);

      const paymentDoc =
        await paymentRef.get();

      if (!paymentDoc.exists) {
        return res.json({
          success: false,
          message:
            "Payment not found",
        });
      }

      const payment =
        paymentDoc.data();

      ////////////////////////////////////////////////////////////
      /// FETCH BOOKING
      ////////////////////////////////////////////////////////////

      const bookingRef = db
        .collection("bookings")
        .doc(bookingId);

      const bookingDoc =
        await bookingRef.get();

      if (!bookingDoc.exists) {
        return res.json({
          success: false,
          message:
            "Booking not found",
        });
      }

      const booking =
        bookingDoc.data();

      ////////////////////////////////////////////////////////////
      /// UPDATE PAYMENT
      ////////////////////////////////////////////////////////////

      await paymentRef.update({
        paymentId: payment_id,
        status: "success",
        paidAt:
          admin.firestore.FieldValue.serverTimestamp(),
      });

      ////////////////////////////////////////////////////////////
      /// ADVANCE PAYMENT
      ////////////////////////////////////////////////////////////

      if (
        payment.type ===
        "advance"
      ) {
        await bookingRef.update({
          advancePaid: true,
          status:
            "advance_paid",
        });
      }

      ////////////////////////////////////////////////////////////
      /// FINAL PAYMENT
      ////////////////////////////////////////////////////////////

      if (
        payment.type === "final"
      ) {
        //////////////////////////////////////////////////////////
        /// WALLET UPDATE
        //////////////////////////////////////////////////////////

        if (!booking.isCounted) {
          const commission =
            booking.totalPrice *
            0.1;

          const providerAmount =
            booking.totalPrice -
            commission;

          await db
            .collection(
              "providers"
            )
            .doc(
              booking.providerId
            )
            .update({
              wallet:
                admin.firestore.FieldValue.increment(
                  providerAmount
                ),

              totalJobs:
                admin.firestore.FieldValue.increment(
                  1
                ),

              totalEarnings:
                admin.firestore.FieldValue.increment(
                  providerAmount
                ),
            });

          await bookingRef.update({
            isCounted: true,
          });
        }

        //////////////////////////////////////////////////////////
        /// COMPLETE BOOKING
        //////////////////////////////////////////////////////////

        await bookingRef.update({
          finalPaid: true,
          status: "completed",

          completedAt:
            admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      ////////////////////////////////////////////////////////////
      /// RESPONSE
      ////////////////////////////////////////////////////////////

      res.json({
        success: true,
      });

    } catch (error) {
      console.log(
        "VERIFY ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          error.message ||
          "Verification failed",
      });
    }
  }
);

////////////////////////////////////////////////////////////
/// 💰 WITHDRAW REQUEST
////////////////////////////////////////////////////////////

app.post("/withdraw", async (req, res) => {
  try {
    const {
      providerId,
      amount,
    } = req.body;

    ////////////////////////////////////////////////////////////
    /// VALIDATION
    ////////////////////////////////////////////////////////////

    if (
      !providerId ||
      !amount
    ) {
      return res.status(400).json({
        success: false,
        message:
          "providerId and amount required",
      });
    }

    if (
      amount <= 0 ||
      amount < 100
    ) {
      return res.json({
        success: false,
        message:
          "Minimum ₹100 required",
      });
    }

    ////////////////////////////////////////////////////////////
    /// FETCH PROVIDER
    ////////////////////////////////////////////////////////////

    const providerRef = db
      .collection("providers")
      .doc(providerId);

    ////////////////////////////////////////////////////////////
    /// FIRESTORE TRANSACTION
    ////////////////////////////////////////////////////////////

    await db.runTransaction(
      async (t) => {
        const doc =
          await t.get(
            providerRef
          );

        if (!doc.exists) {
          throw new Error(
            "Provider not found"
          );
        }

        const provider =
          doc.data();

        const wallet =
          provider.wallet || 0;

        //////////////////////////////////////////////////////////
        /// BALANCE CHECK
        //////////////////////////////////////////////////////////

        if (amount > wallet) {
          throw new Error(
            "Insufficient balance"
          );
        }

        //////////////////////////////////////////////////////////
        /// DEDUCT WALLET
        //////////////////////////////////////////////////////////

        t.update(
          providerRef,
          {
            wallet:
              admin.firestore.FieldValue.increment(
                -amount
              ),
          }
        );

        //////////////////////////////////////////////////////////
        /// CREATE WITHDRAW ENTRY
        //////////////////////////////////////////////////////////

        const withdrawRef =
          db
            .collection(
              "withdrawals"
            )
            .doc();

        t.set(
          withdrawRef,
          {
            providerId,
            amount,

            status: "pending",

            createdAt:
              admin.firestore.FieldValue.serverTimestamp(),

            processedAt: null,

            transactionId:
              null,

            method: "upi",

            upi:
              provider.upi ||
              null,

            note: null,

            isProcessed: false,
          }
        );
      }
    );

    ////////////////////////////////////////////////////////////
    /// RESPONSE
    ////////////////////////////////////////////////////////////

    res.json({
      success: true,
      message:
        "Withdraw request created",
    });

  } catch (error) {
    console.log(
      "WITHDRAW ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      message:
        error.message ||
        "Withdraw failed",
    });
  }
});

////////////////////////////////////////////////////////////
/// ✅ APPROVE WITHDRAW
////////////////////////////////////////////////////////////

app.post(
  "/approve-withdraw",
  async (req, res) => {
    try {
      const {
        withdrawId,
        transactionId,
      } = req.body;

      ////////////////////////////////////////////////////////////
      /// VALIDATION
      ////////////////////////////////////////////////////////////

      if (
        !withdrawId ||
        !transactionId
      ) {
        return res.json({
          success: false,
          message:
            "withdrawId and transactionId required",
        });
      }

      ////////////////////////////////////////////////////////////
      /// FETCH WITHDRAW
      ////////////////////////////////////////////////////////////

      const withdrawRef = db
        .collection(
          "withdrawals"
        )
        .doc(withdrawId);

      const withdrawDoc =
        await withdrawRef.get();

      if (
        !withdrawDoc.exists
      ) {
        return res.json({
          success: false,
          message:
            "Withdraw request not found",
        });
      }

      const withdraw =
        withdrawDoc.data();

      ////////////////////////////////////////////////////////////
      /// ALREADY PROCESSED
      ////////////////////////////////////////////////////////////

      if (
        withdraw.status !==
        "pending"
      ) {
        return res.json({
          success: false,
          message:
            "Already processed",
        });
      }

      ////////////////////////////////////////////////////////////
      /// UPDATE
      ////////////////////////////////////////////////////////////

      await withdrawRef.update({
        status: "completed",

        transactionId:
          transactionId,

        processedAt:
          admin.firestore.FieldValue.serverTimestamp(),

        isProcessed: true,
      });

      ////////////////////////////////////////////////////////////
      /// RESPONSE
      ////////////////////////////////////////////////////////////

      res.json({
        success: true,
        message:
          "Withdraw approved",
      });

    } catch (error) {
      console.log(
        "APPROVE ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          error.message,
      });
    }
  }
);

////////////////////////////////////////////////////////////
/// ❌ REJECT WITHDRAW
////////////////////////////////////////////////////////////

app.post(
  "/reject-withdraw",
  async (req, res) => {
    try {
      const {
        withdrawId,
        reason,
      } = req.body;

      ////////////////////////////////////////////////////////////
      /// VALIDATION
      ////////////////////////////////////////////////////////////

      if (!withdrawId) {
        return res.json({
          success: false,
          message:
            "withdrawId required",
        });
      }

      ////////////////////////////////////////////////////////////
      /// FETCH WITHDRAW
      ////////////////////////////////////////////////////////////

      const withdrawRef = db
        .collection(
          "withdrawals"
        )
        .doc(withdrawId);

      const withdrawDoc =
        await withdrawRef.get();

      if (
        !withdrawDoc.exists
      ) {
        return res.json({
          success: false,
          message:
            "Withdraw request not found",
        });
      }

      const withdraw =
        withdrawDoc.data();

      ////////////////////////////////////////////////////////////
      /// ALREADY PROCESSED
      ////////////////////////////////////////////////////////////

      if (
        withdraw.status !==
        "pending"
      ) {
        return res.json({
          success: false,
          message:
            "Already processed",
        });
      }

      ////////////////////////////////////////////////////////////
      /// REFUND WALLET
      ////////////////////////////////////////////////////////////

      const providerRef = db
        .collection(
          "providers"
        )
        .doc(
          withdraw.providerId
        );

      await providerRef.update({
        wallet:
          admin.firestore.FieldValue.increment(
            withdraw.amount
          ),
      });

      ////////////////////////////////////////////////////////////
      /// UPDATE WITHDRAW
      ////////////////////////////////////////////////////////////

      await withdrawRef.update({
        status: "rejected",

        note:
          reason ||
          "Rejected by admin",

        processedAt:
          admin.firestore.FieldValue.serverTimestamp(),

        isProcessed: true,
      });

      ////////////////////////////////////////////////////////////
      /// RESPONSE
      ////////////////////////////////////////////////////////////

      res.json({
        success: true,
        message:
          "Withdraw rejected",
      });

    } catch (error) {
      console.log(
        "REJECT ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          error.message,
      });
    }
  }
);

////////////////////////////////////////////////////////////
/// 🚀 SERVER
////////////////////////////////////////////////////////////

const PORT =
  process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(
    `Server running on port ${PORT} 🚀`
  );
});