const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const port = process.env.PORT || 3000;
const crypto = require("crypto");

const admin = require("firebase-admin");

// const serviceAccount = require(process.env.ADMIN_SDK);

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

function generateTrackingId() {
  const random = crypto.randomBytes(5).toString("hex").toUpperCase();
  return `ZAP-${random}`;
}

const stripe = require("stripe")(process.env.STRIPE_ID);

// middleware
app.use(express.json());
app.use(cors());

const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).send({ message: "unauthorized token" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decode = await admin.auth().verifyIdToken(idToken);
    req.access_email = decode.email;

    next();
  } catch (err) {
    return res.status(401).send({ message: "forbidden" });
  }
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.avcddas.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("zap_shift_db");
    const userCollection = db.collection("users");
    const parcelsCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const ridersCollection = db.collection("riders");
    const trackingsCollection = db.collection("trackings");

    // middleware for verify user role
    const verifyAdmin = async (req, res, next) => {
      const email = req.access_email;
      const query = { email };
      const user = await userCollection.findOne(query);

      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "Forbidden Access" });
      }
      next();
    };

    const verifyRider = async (req, res, next) => {
      const email = req.access_email;
      const query = { email };
      const user = await userCollection.findOne(query);

      if (!user || user.role !== "rider") {
        return res.status(403).send({ message: "Forbidden Access" });
      }
      next();
    };

    const logTracking = async (trackingId, status) => {
      const log = {
        trackingId,
        status,
        details: status.split("-").join(" "),
        createdAt: new Date(),
      };

      const result = await trackingsCollection.insertOne(log);
      return result;
    };

    // users related APIs
    app.get("/users", async (req, res) => {
      const searchText = req.query.searchText;
      const query = {};
      if (searchText) {
        // query.name = {$regex: searchText, $options: 'i'};

        query.$or = [
          { name: { $regex: searchText, $options: "i" } },
          { email: { $regex: searchText, $options: "i" } },
        ];
      }

      const cursor = userCollection
        .find(query)
        .sort({ createdAt: -1 })
        .limit(4);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const result = await userCollection.findOne(query);
      res.send(result.role);
    });

    app.patch(
      "/users/:id/role",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const role = req.body.role;
        const query = { _id: new ObjectId(id) };
        const updatedRole = {
          $set: {
            role: role,
          },
        };
        const result = await userCollection.updateOne(query, updatedRole);
        res.send(result);
      }
    );

    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createdAt = new Date();
      const email = user.email;
      const isUserExists = await userCollection.findOne({ email });

      if (isUserExists) {
        return res.send({ message: "user already exists" });
      }

      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    // parcel APIs
    app.get("/parcels", async (req, res) => {
      const query = {};

      const { email, deliveryStatus } = req.query;
      if (email) {
        query.senderEmail = email;
      }

      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      }

      const options = { sort: { createdAt: -1 } };

      const cursor = parcelsCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/parcels/delivery-status/stats", async (req, res) => {
      const pipeline = [
        {
          $group: {
            _id: "$deliveryStatus",
            count: { $sum: 1 },
          },
        },
        {
          $project: {
            status: "$_id",
            count: 1,
            // _id: 0
          },
        },
      ];
      const result = await parcelsCollection.aggregate(pipeline).toArray();
      res.send(result);
    });

    app.get("/parcels/rider", async (req, res) => {
      const { riderEmail, deliveryStatus } = req.query;
      const query = {};

      if (riderEmail) {
        query.riderEmail = riderEmail;
      }

      if (deliveryStatus !== "delivered") {
        // query.deliveryStatus = { $in: ["rider_assigned", "rider_arriving"] };
        query.deliveryStatus = { $nin: ["delivered"] };
      } else {
        query.deliveryStatus = deliveryStatus;
      }

      const cursor = parcelsCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.findOne(query);
      res.send(result);
    });

    app.post("/parcels", async (req, res) => {
      const parcels = req.body;
      const trackingId = generateTrackingId();
      // set Time
      parcels.createdAt = new Date();
      parcels.trackingId = trackingId;

      logTracking(trackingId, "parcel-created");

      const result = await parcelsCollection.insertOne(parcels);
      res.send(result);
    });

    app.patch("/parcels/:id", async (req, res) => {
      const { riderId, riderName, riderEmail, riderPhoneNumber, trackingId } =
        req.body;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const updatedDocs = {
        $set: {
          deliveryStatus: "rider-assigned",
          riderId: riderId,
          riderName: riderName,
          riderEmail: riderEmail,
          riderPhoneNumber: riderPhoneNumber,
        },
      };

      const result = await parcelsCollection.updateOne(query, updatedDocs);

      // update rider information
      const riderQuery = { _id: new ObjectId(riderId) };
      const riderUpdatedDoc = {
        $set: {
          workStatus: "in-delivery",
        },
      };

      // TrackingLog
      logTracking(trackingId, "driver-assigned");

      const riderUpdatedResult = await ridersCollection.updateOne(
        riderQuery,
        riderUpdatedDoc
      );

      res.send(riderUpdatedResult);
    });

    app.patch("/parcels/:id/status", async (req, res) => {
      const { deliveryStatus, riderId, trackingId } = req.body;
      const query = { _id: new ObjectId(req.params.id) };
      const updatedInfo = {
        $set: {
          deliveryStatus: deliveryStatus,
        },
      };

      // Update rider status
      const riderQuery = { _id: new ObjectId(riderId) };
      const updatedDoc = {
        $set: {
          workStatus: "available",
        },
      };
      const riderRes = await ridersCollection.updateOne(riderQuery, updatedDoc);

      // Log Tracking
      logTracking(trackingId, deliveryStatus);

      const result = await parcelsCollection.updateOne(query, updatedInfo);
      res.send(result);
    });

    app.patch("/parcels/:id/reject", async (req, res) => {
      const { deliveryStatus, riderId } = req.body;
      const query = { _id: new ObjectId(req.params.id) };
      const updatedDoc = {
        $set: {
          deliveryStatus: deliveryStatus,
        },
      };

      // Update rider status
      const riderQuery = { _id: new ObjectId(riderId) };
      const riderUpdatedDoc = {
        $set: {
          workStatus: "available",
        },
      };

      const riderRes = await ridersCollection.updateOne(
        riderQuery,
        riderUpdatedDoc
      );

      const result = await parcelsCollection.updateOne(query, updatedDoc);
      res.send(result);
    });

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.deleteOne(query);
      res.send(result);
    });

    //Payment APIs
    app.post("/payment-checkout-session", async (req, res) => {
      const parcelInfo = req.body;
      const amount = parseInt(parcelInfo.cost * 100);

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: amount,
              product_data: {
                name: `Please Pay For ${parcelInfo.parcelName}`,
              },
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        customer_email: parcelInfo.senderEmail,
        metadata: {
          parcelId: parcelInfo.parcelId,
          parcelName: parcelInfo.parcelName,
          trackingId: parcelInfo.trackingId,
        },
        success_url: `${process.env.STRIPE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.STRIPE_DOMAIN}/dashboard/payment-cancelled?session_id={CHECKOUT_SESSION_ID}`,
      });

      res.send({ url: session.url });
    });

    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      const trackingId = session.metadata.trackingId;

      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId };
      const isExist = await paymentCollection.findOne(query);
      if (isExist) {
        return res.send({
          transactionId,
          message: "already paid",
          trackingId: isExist.trackingId,
        });
      }

      if (session.payment_status === "paid") {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            payment_status: "paid",
            deliveryStatus: "pending-pickup",
            trackingId: trackingId,
          },
        };
        const result = await parcelsCollection.updateOne(query, update);

        const payment = {
          customerEmail: session.customer_email,
          amount: session.amount_total / 100,
          currency: session.currency,
          parcelId: session.metadata.parcelId,
          parcelName: session.metadata.parcelName,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingId: trackingId,
        };

        logTracking(trackingId, "parcel-paid");
        const paymentResult = await paymentCollection.insertOne(payment);
        return res.send({
          status: true,
          modifyParcel: result,
          trackingId: trackingId,
          transactionId: session.payment_intent,
          paymentInfo: paymentResult,
        });
      }
    });

    app.get("/payments", verifyFBToken, async (req, res) => {
      const email = req.query.email;

      const query = {};
      if (email) {
        query.customerEmail = email;

        if (email !== req.access_email) {
          return res.status(403).send({ message: "forbidden access" });
        }
      }

      const cursor = paymentCollection.find(query).sort({ paidAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    // old
    app.post("/payment-checkout-session-old", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost);

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "USD",
              unit_amount: amount,
              product_data: {
                name: paymentInfo.parcelName,
              },
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo.senderEmail,
        mode: "payment",
        metadata: {
          parcelId: paymentInfo.parcelId,
        },
        success_url: `${process.env.STRIPE_DOMAIN}/dashboard/payment-success`,
        cancel_url: `${process.env.STRIPE_DOMAIN}/dashboard/payment-cancelled`,
      });

      res.send({ url: session.url });
    });

    // Rider Related APIs
    app.get("/riders", async (req, res) => {
      const { status, ridersDistrict, workStatus } = req.query;

      const query = {};
      if (status) {
        query.status = status;
      }

      if (ridersDistrict) {
        query.ridersDistrict = ridersDistrict;
      }

      if (workStatus) {
        query.workStatus = workStatus;
      }

      const cursor = ridersCollection.find(query).sort({ createdAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/riders/delivery-per-day", async (req, res) => {
      const email = req.query.email;
      const pipeline = [
        {
          $match: {
            riderEmail: email,
          },
        },
        {
          $lookup: {
            from: "trackings",
            localField: "trackingId",
            foreignField: "trackingId",
            as: "parcel-status",
          },
        },
        {
          $unwind: "$parcel-status",
        },
        {
          $match: {
            "parcel-status.status": "delivered",
          },
        },
        {
          $addFields: {
            deliveredDate: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$parcel-status.createdAt",
              },
            },
          },
        },

        {
          $group: {
            _id: "$deliveredDate",
            count: { $sum: 1 },
          },
        },
      ];

      const result = await parcelsCollection.aggregate(pipeline).toArray();
      res.send(result);
    });

    app.patch(
      "/rider-approved/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const status = req.body.status;
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const updatedInfo = {
          $set: {
            status: status,
            workStatus: "available",
          },
        };
        const result = await ridersCollection.updateOne(query, updatedInfo);

        if (status === "approved") {
          const email = req.body.email;
          const query = { email };
          const updateUser = {
            $set: {
              role: "rider",
            },
          };
          const userResult = await userCollection.updateOne(query, updateUser);
        }
        res.send(result);
      }
    );

    app.delete("/riders/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await ridersCollection.deleteOne(query);

      res.send(result);
    });

    app.post("/riders", async (req, res) => {
      const rider = req.body;
      rider.status = "pending";
      rider.createdAt = new Date();

      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });

    // Tracking Related APIs
    app.get("/trackings/:trackingId/logs", async (req, res) => {
      const trackingId = req.params.trackingId;
      const query = { trackingId };
      const result = await trackingsCollection.find(query).toArray();
      res.send(result);
    });

    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    // console.log(
    //   "Pinged your deployment. You successfully connected to MongoDB!"
    // );
  } finally {
    // Ensures that the client will close when you finish/error
    //   await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Zap is shifting");
});

app.listen(port, () => {
  console.log(`server is listening to port: ${port}`);
});
