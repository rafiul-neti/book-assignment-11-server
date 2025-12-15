require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
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
  // console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    // console.log(decoded);
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

    // middleware that needs to load data from database
    // must use after verifyFirebase middleware
    const verifyAdmin = async (req, res, next) => {
      const email = req.tokenEmail;
      const query = { email };

      const user = await usersColl.findOne(query);

      if (!user || user.userRole !== "admin") {
        return res.status(403).send({ message: "forbidden access!" });
      }

      next();
    };

    const verifyLibrarian = async (req, res, next) => {
      const email = req.tokenEmail;
      const query = { email };

      const user = await usersColl.findOne(query);

      if (!user || user.userRole !== "librarian") {
        return res.status(403).send({ message: "forbidden access!" });
      }

      next();
    };

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
    app.get("/users", verifyJWT, verifyAdmin, async (req, res) => {
      const { searchText } = req.query;
      const query = {};
      if (searchText) {
        query.$or = [
          { displayName: { $regex: searchText, $options: "i" } },
          { email: { $regex: searchText, $options: "i" } },
        ];
      }
      const result = await usersColl.find(query).toArray();
      res.send(result);
    });

    app.get("/users/:email/role", verifyJWT, async (req, res) => {
      const { email } = req.params;
      const query = { email };
      const user = await usersColl.findOne(query);

      res.send({
        role: user?.userRole || "user",
      });
    });

    app.post("/users", async (req, res) => {
      const user = req.body;

      console.log(user);

      const existingUser = await usersColl.findOne({ email: user.email });
      if (existingUser) {
        return res.send({ message: "user already exists." });
      }

      // generating an user ID

      // adding the userRole, userID and the user creation time
      user.userRole = "user";
      user.createdAt = new Date().toLocaleString();

      const result = await usersColl.insertOne(user);
      res.send(result);
    });

    app.patch("/users/:id/role", verifyJWT, verifyAdmin, async (req, res) => {
      const { id } = req.params;
      const { role } = req.body;
      console.log(req.body);

      const query = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          userRole: role,
        },
      };

      const result = await usersColl.updateOne(query, updatedDoc);
      res.send(result);
    });

    // books related api's
    app.get("/all-books", async (req, res) => {
      let {
        status,
        sortBy,
        limit,
        skip,
        sortOrder = "asc",
        searchByTitle,
      } = req.query;

      // console.log({ status, sortByDate });

      if (!["asc", "desc"].includes(sortOrder)) {
        sortOrder = "asc";
      }

      let sort = null;
      if (sortBy === "date") {
        const order = sortOrder === "asc" ? 1 : -1;
        sort = { createdAt: order };
      } else if (sortBy === "price") {
        const order = sortOrder === "asc" ? 1 : -1;
        sort = { bookPrice: order };
      }

      const query = {};
      if (status.toLowerCase() === "published") {
        query.bookStatus = "Published";
      } else if (status.toLowerCase() === "unpublished") {
        query.bookStatus = "Unpublished";
      }

      if (searchByTitle) {
        query.bookName = { $regex: searchByTitle, $options: "i" };
      }

      const totalBooks = await booksColl.countDocuments(query);

      let cursor = booksColl.find(query);

      if (sort) {
        cursor = cursor.sort(sort);
      }

      const result = await cursor
        .skip(Number(skip) || 0)
        .limit(Number(limit) || 0)
        .toArray();

      res.send({ result, totalBooks });
    });

    app.get("/books/:id/details", async (req, res) => {
      const { id } = req.params;
      const query = { _id: new ObjectId(id) };

      const result = await booksColl.findOne(query);
      res.send(result);
    });

    app.post("/books", verifyJWT, verifyLibrarian, async (req, res) => {
      const bookInfo = req.body;

      const trackingId = generateTrackingId();

      bookInfo.createdAt = new Date();
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
