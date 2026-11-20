import express from "express";
import "dotenv/config";
import cors from "cors";
import { MongoClient } from "mongodb";

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
    console.dir(err);
  }
}

const connectedClient = await connectToMongoDB();
const db = connectedClient.db("fixMateDb");
const servicesCollection = db.collection("services");
const bookingsCollection = db.collection("bookings");
const paymentsCollection = db.collection("payments");

app.get("/services", async (req, res) => {
  const result = await servicesCollection.find(query).toArray();
  res.send(result);
});

app.get("/services/:email", async (req, res) => {
  const email = req.params.email;
  const query = { technicianEmail: email };
  const result = await servicesCollection.find(query).toArray();
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

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
