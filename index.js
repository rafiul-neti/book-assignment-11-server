require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const app = express();

const stripe = require("stripe")(process.env.PAYMENT);

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
    const ordersColl = db.collection("orders");
    const wishlistsColl = db.collection("wishlists");
    const paymentsColl = db.collection("payments");

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
      let { status, email, sortBy, limit, skip, sortOrder, searchByTitle } =
        req.query;

      // console.log({ status, sortByDate });

      let sort = null;

      if (sortBy && sortOrder && ["asc", "desc"].includes(sortOrder)) {
        const order = sortOrder === "asc" ? 1 : -1;

        if (sortBy === "date") {
          sort = { createdAt: order };
        }

        if (sortBy === "price") {
          sort = { bookPrice: order };
        }
      }

      const query = {};
      if (status) {
        if (status.toLowerCase() === "published") {
          query.bookStatus = "Published";
        } else if (status.toLowerCase() === "unpublished") {
          query.bookStatus = "Unpublished";
        }
      }

      // for to get how many books added by a single librarian
      if (email) {
        query.librarianEmail = email;
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

      res.send({ success: true, result, totalBooks });
    });

    app.get("/books/:id/details", async (req, res) => {
      const { id } = req.params;
      const query = { _id: new ObjectId(id) };

      const result = await booksColl.findOne(query);

      const librarianQuery = { email: result.librarianEmail };
      const whoIsLibrarian = await usersColl.findOne(librarianQuery);

      res.send({ success: true, result, whoIsLibrarian });
    });

    app.post("/books", verifyJWT, verifyLibrarian, async (req, res) => {
      const bookInfo = req.body;

      bookInfo.createdAt = new Date();

      const result = await booksColl.insertOne(bookInfo);
      res.send(result);
    });

    app.patch("/books/:id", verifyJWT, async (req, res) => {
      const { id } = req.params;
      const { status } = req.body;

      const query = { _id: new ObjectId(id) };
      const updateStatus = {
        $set: {
          bookStatus: status,
        },
      };

      const result = await booksColl.updateOne(query, updateStatus);
      res.send(result);
    });

    app.delete("/books/:id", verifyJWT, verifyAdmin, async (req, res) => {
      const { id } = req.params;

      const query = { _id: new ObjectId(id) };
      const orderDeleteQuery = { bookId: id };

      const result = await booksColl.deleteOne(query);
      const deleteOrders = await ordersColl.deleteMany(orderDeleteQuery);

      res.send({
        success: true,
        bookDeletation: result,
        orderDeletation: deleteOrders,
      });
    });

    // orders related api's
    app.get("/orders", async (req, res) => {
      const { customerEmail, librarianEmail } = req.query;

      const query = {};
      if (customerEmail || librarianEmail) {
        if (customerEmail) {
          query.customerEmail = customerEmail;
        }

        if (librarianEmail) {
          query.librarianEmail = librarianEmail;
        }
      }

      const result = await ordersColl
        .find(query)
        .sort({ orderedAt: -1 })
        .toArray();
      res.send(result);
    });

    app.post("/orders", async (req, res) => {
      const orderInfo = req.body;

      const existingOrder = await ordersColl.findOne({
        bookId: orderInfo.bookId,
        customerEmail: orderInfo.customerEmail,
      });

      console.log(existingOrder);
      if (existingOrder) {
        return res.send({
          message:
            "Sorry! You've already ordered this book. We haven't added the multiple order functionalities yet.",
        });
      }

      // generating trackingId for order
      const trackingId = generateTrackingId();

      orderInfo.orderStatus = "pending";
      orderInfo.paymentStatus = "unpaid";
      orderInfo.trackingId = trackingId;

      const result = await ordersColl.insertOne(orderInfo);

      // log tracking
      logTracking(trackingId, "book_has_ordered");

      res.send(result);
    });

    app.patch("/orders/:id", verifyJWT, async (req, res) => {
      const { id } = req.params;
      const { status, trackingId } = req.body;

      const query = { _id: new ObjectId(id) };
      const updatedStatus = {
        $set: {
          orderStatus: status,
        },
      };

      const result = await ordersColl.updateOne(query, updatedStatus);

      logTracking(trackingId, `book_order_${status}`);

      res.send(result);
    });

    // wishlist related api
    app.get("/wishlists", verifyJWT, async (req, res) => {
      const { email } = req.query;
      const query = { wishlister: email };

      const result = await wishlistsColl.find(query).toArray();
      res.send(result);
    });

    app.post("/wishlist", verifyJWT, async (req, res) => {
      const favBook = req.body;

      favBook.bookId = new ObjectId(favBook._id);
      // Remove book _id
      delete favBook._id;

      console.log(favBook);

      const query = {
        bookId: favBook.bookId,
        wishlister: favBook.wishlister,
      };

      const existingBook = await wishlistsColl.findOne(query);

      if (existingBook) {
        return res.send({ message: "Book already in wishlist." });
      }

      const result = await wishlistsColl.insertOne(favBook);
      res.send(result);
    });

    app.delete("/wishlists/:id", verifyJWT, async (req, res) => {
      const { id } = req.params;
      const { userEmail } = req.query;

      // console.log({ from: "delete wishlist", id, userEmail });

      const query = { bookId: new ObjectId(id), wishlister: userEmail };
      const result = await wishlistsColl.deleteOne(query);

      res.send(result);
    });

    // payment related api's
    app.get("/payments", verifyJWT, async (req, res) => {
      const { user } = req.query;
      const query = { customerEmail: user };

      const result = await paymentsColl
        .find(query)
        .sort({ paidAt: -1 })
        .toArray();
      res.send(result);
    });

    app.post("/payment-checkout-session", async (req, res) => {
      const bookInfo = req.body;

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "bdt",
              unit_amount: parseInt(bookInfo.bookPrice * 100),
              product_data: {
                name: `Please pay for ${bookInfo.bookName}`,
              },
            },
            quantity: 1,
          },
        ],
        customer_email: bookInfo.customerEmail,
        mode: "payment",
        metadata: {
          bookId: bookInfo.bookId,
          bookName: bookInfo.bookName,
          trackingId: bookInfo.trackingId,
        },
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });

      res.send({ url: session.url });
    });

    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;

      const session = await stripe.checkout.sessions.retrieve(sessionId);

      const transactionId = session.payment_intent;

      const query = { transactionId: transactionId };
      const paymentExist = await paymentsColl.findOne(query);

      if (paymentExist) {
        return res.send({
          message: "payment already exist",
          transactionId,
          trackingId: paymentExist.trackingId,
        });
      }

      if (session.payment_status === "paid") {
        const { bookId, bookName, trackingId } = session.metadata;
        const query = { bookId, customerEmail: session.customer_email };
        const update = {
          $set: {
            paymentStatus: "paid",
          },
        };

        const result = await ordersColl.updateOne(query, update);

        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          bookId,
          bookName,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingId,
        };

        const resultPayment = await paymentsColl.insertOne(payment);

        logTracking(trackingId, "payment_completed");

        return res.send({
          success: true,
          modifyParcel: result,
          trackingId: trackingId,
          transactionId: session.payment_intent,
          paymentInfo: resultPayment,
        });
      }
      return res.send({ success: false });
    });

    // book parcel tracking related api's
    app.get("/trackings/:trackingId", async (req, res) => {
      const { trackingId } = req.params;
      const query = { trackingId };

      const result = await trackingsColl.find(query).toArray();
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
