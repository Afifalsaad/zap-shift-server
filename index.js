const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const port = process.env.PORT || 3000;

const stripe = require("stripe")(process.env.STRIPE_ID);

// middleware
app.use(express.json());
app.use(cors());

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
    const parcelsCollection = db.collection("parcels");

    // parcel APIs
    app.get("/parcels", async (req, res) => {
      const query = {};

      const { email } = req.query;
      if (email) {
        query.senderEmail = email;
      }

      const options = { sort: { createdAt: -1 } };

      const cursor = parcelsCollection.find(query, options);
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
      // set Time
      parcels.createdAt = new Date();

      const result = await parcelsCollection.insertOne(parcels);
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
        },
        success_url: `${process.env.STRIPE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.STRIPE_DOMAIN}/dashboard/payment-cancelled?session_id={CHECKOUT_SESSION_ID}`,
      });

      res.send({ url: session.url });
    });

    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;

      const session = await stripe.checkout.sessions.retrieve(sessionId);
      console.log("session", session);
      if (session.payment_status === "paid") {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            payment_status: "paid",
          },
        };
        const result = await parcelsCollection.updateOne(query, update);
        res.send(result);
      }

      res.send({ success: false });
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

      console.log(session);
      res.send({ url: session.url });
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
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
