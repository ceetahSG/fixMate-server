import express from "express";
import "dotenv/config";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";

const app = express();

app.use(express.json());
app.use(cors());

const port = process.env.PORT || 5000;

const client = new MongoClient(process.env.MONGODB_URI);
export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.error("MongoDB connection failed:", err);
    throw err;
  }
}

const connectedClient = await connectToMongoDB();
const db = connectedClient.db("fixMateDb");
const servicesCollection = db.collection("services");
const bookingsCollection = db.collection("bookings");
const paymentsCollection = db.collection("payments");
const usersCollection = db.collection("user");

app.get("/services", async (req, res) => {
  const query = {};
  console.log("Query parameters:", req.query);
  if (req.query.category) {
    query.category = req.query.category;
  }
  const result = await servicesCollection.find(query).toArray();

  res.send(result);
});

app.get("/services/:value", async (req, res) => {
  const value = req.params.value;

  if (/^[0-9a-fA-F]{24}$/.test(value)) {
    const result = await servicesCollection.findOne({
      _id: new ObjectId(value),
    });
    return res.send(result);
  }

  const result = await servicesCollection
    .find({ technicianEmail: value })
    .toArray();
  res.send(result);
});

app.get("/users", async (req, res) => {
  try {
    const result = await usersCollection.find({}).toArray();
    res.send(result);
  } catch (err) {
    console.error("Failed to fetch users:", err);
    res.status(500).send({ message: "Failed to fetch users" });
  }
});

app.patch("/users/:id", async (req, res) => {
  const id = req.params.id;
  const filter = { _id: new ObjectId(id) };
  const updatedUser = req.body;
  const result = await usersCollection.updateOne(filter, {
    $set: updatedUser,
  });
  res.send(result);
});

app.post("/services", async (req, res) => {
  const service = req.body;
  console.log(service);
  const result = await servicesCollection.insertOne(service);
  res.send(result);
});

app.get("/", async (req, res) => {
  res.send("Server is running");
});

app.patch("/services/:id", async (req, res) => {
  const id = req.params.id;
  const filter = { _id: new ObjectId(id) };
  const updatedService = req.body;
  const result = await servicesCollection.updateOne(filter, {
    $set: updatedService,
  });
  res.send(result);
});

app.delete("/delete-services/:id", async (req, res) => {
  const id = req.params.id;
  console.log("Deleting service with ID:", id);
  const filter = { _id: new ObjectId(id) };
  const result = await servicesCollection.deleteOne(filter);
  res.send(result);
});

app.post("/bookings", async (req, res) => {
  const booking = req.body;
  const result = await bookingsCollection.insertOne(booking);
  res.send(result);
});

app.get("/bookings", async (req, res) => {
  const query = {};
  if (req.query.customerEmail) {
    query.customerEmail = req.query.customerEmail;
  }
  if (req.query.technicianEmail) {
    query.technicianEmail = req.query.technicianEmail;
  }
  const result = await bookingsCollection.find(query).toArray();
  res.send(result);
});

app.patch("/bookings/:id", async (req, res) => {
  const id = req.params.id;
  const filter = { _id: new ObjectId(id) };
  const updatedBooking = req.body;
  const result = await bookingsCollection.updateOne(filter, {
    $set: updatedBooking,
  });
  res.send(result);
});

app.delete("/bookings/:id", async (req, res) => {
  const id = req.params.id;
  const filter = { _id: new ObjectId(id) };
  const result = await bookingsCollection.deleteOne(filter);
  res.send(result);
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
