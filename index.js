require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");
const app = express();

const crypto = require("crypto");

const admin = require("firebase-admin");
const port = process.env.PORT || 3000;
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

function generateTrackingId() {
  const prefix = "BOOK";
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();

  return `${prefix}-${date}-${random}`;
}

function generateUserId() {
  const prefix = "USER";
  const date = new Date().toISOString().slice(2, 14).replace(/-/g, "");
  const random = crypto.randomBytes(5).toString("hex").toUpperCase();

  return `${prefix}-${date}-${random}`;
}

// middleware
app.use(
  cors({
    origin: "http://localhost:5173",
    credentials: true,
  })
);
app.use(express.json());

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    const db = client.db("bookCourier");
    const booksColl = db.collection("books");
    const usersColl = db.collection("users");
    const trackingsColl = db.collection("trackings");

    // logs for book tracking
    const logTracking = async (trackingId, status) => {
      const log = {
        trackingId,
        status,
        message: status.split("_").join(" "),
        createdAt: new Date().toLocaleString(),
      };

      const result = await trackingsColl.insertOne(log);
      return result;
    };

    // users related apis
    app.post("/users", async (req, res) => {
      const user = req.body;

      // genersting an user ID
      const userId = generateUserId();

      // adding the userRole, userID and the user creation time
      user.userRole = "user";
      user.createdAt = new Date().toLocaleString();
      user.userId = userId;

      const result = await usersColl.insertOne(user);
      res.send(result);
    });

    // books related api's
    app.post("/books", async (req, res) => {
      const bookInfo = req.body;

      const trackingId = generateTrackingId();

      bookInfo.createdAt = new Date().toLocaleString();
      bookInfo.trackingId = trackingId;

      const result = await booksColl.insertOne(bookInfo);

      // log tracking
      logTracking(trackingId, "book_parcel_created");

      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from Server..");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
