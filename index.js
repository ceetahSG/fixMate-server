import express from "express";
import "dotenv/config";
import cors from "cors";
import Stripe from "stripe";
import { MongoClient, ObjectId } from "mongodb";
import { createRemoteJWKSet, jwtVerify } from "jose";

const app = express();
app.use(express.json());

// All environment-specific URLs come from .env — nothing is hard-coded here.
const requiredEnv = (name) => {
  const value = typeof process.env[name] === "string" ? process.env[name].trim() : "";
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const trimTrailingSlash = (value) => value.replace(/\/+$/, "");

const frontendUrl = trimTrailingSlash(requiredEnv("FRONTEND_URL"));
const jwksUrl = new URL(requiredEnv("JWKS_PATH"), `${frontendUrl}/`).toString();
const allowedOrigins = [
  ...new Set(
    requiredEnv("ALLOWED_ORIGINS")
      .split(",")
      .map((origin) => trimTrailingSlash(origin.trim()))
      .filter(Boolean),
  ),
  frontendUrl,
];
const paymentSuccessUrl = requiredEnv("PAYMENT_SUCCESS_URL");
const paymentCancelUrl = requiredEnv("PAYMENT_CANCEL_URL");
const databaseName = requiredEnv("MONGODB_DB_NAME");

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Origin not allowed"));
    },
  }),
);

const port = process.env.PORT || 5000;

const client = new MongoClient(requiredEnv("MONGODB_URI"));
export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (error) {
    console.error("MongoDB connection failed");
    throw error;
  }
}

const connectedClient = await connectToMongoDB();
const db = connectedClient.db(databaseName);
const servicesCollection = db.collection("services");
const bookingsCollection = db.collection("bookings");
const paymentsCollection = db.collection("payments");
const usersCollection = db.collection("user");

const remoteJwks = createRemoteJWKSet(new URL(jwksUrl));

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const normalizeRole = (role) =>
  typeof role === "string" ? role.trim().toLowerCase() : "";

const validRoles = new Set(["customer", "technician", "admin"]);

// Booking statuses are stored in the lowercase form used by the frontend and
// by existing records; accept the older capitalized spellings on input too.
const normalizeStatus = (status) =>
  typeof status === "string" ? status.trim().toLowerCase() : "";
const bookingStatusAliases = {
  pending: "requested",
  "in progress": "in-progress",
  canceled: "cancelled",
};
const validBookingStatuses = new Set([
  "requested",
  "accepted",
  "rejected",
  "in-progress",
  "completed",
  "cancelled",
]);
const normalizeBookingStatus = (status) => {
  const normalized = normalizeStatus(status);
  return bookingStatusAliases[normalized] ?? normalized;
};

const isAllowedRedirectUrl = (value) => {
  if (typeof value !== "string" || !value) {
    return false;
  }
  try {
    return new URL(value).origin === new URL(frontendUrl).origin;
  } catch {
    return false;
  }
};

const isValidObjectId = (value) =>
  typeof value === "string" && ObjectId.isValid(value);

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const match =
    typeof authHeader === "string"
      ? authHeader.match(/^Bearer\s+(\S+)$/i)
      : null;

  if (!match) {
    return res.status(401).send({ message: "Unauthorized" });
  }

  try {
    const { payload } = await jwtVerify(match[1], remoteJwks, {
      issuer: frontendUrl,
      audience: frontendUrl,
    });

    if (!payload.sub || typeof payload.sub !== "string") {
      return res.status(401).send({ message: "Unauthorized" });
    }

    const subject = payload.sub;
    const idCandidates = [{ _id: subject }];
    if (ObjectId.isValid(subject)) {
      idCandidates.push({ _id: new ObjectId(subject) });
    }
    idCandidates.push({ id: subject });

    const user = await usersCollection.findOne({
      $or: idCandidates,
    });

    if (!user) {
      return res.status(401).send({ message: "Unauthorized" });
    }

    const role = normalizeRole(user.role);
    if (!validRoles.has(role)) {
      return res.status(403).send({ message: "Forbidden" });
    }

    req.user = {
      id: user._id.toString(),
      _id: user._id,
      email: user.email,
      name: user.name,
      role,
    };
    req.auth = { payload, user: req.user };
    return next();
  } catch (error) {
    return res.status(401).send({ message: "Unauthorized" });
  }
};

const verifyRole = (allowedRole) => (req, res, next) => {
  if (!req.user || req.user.role !== allowedRole) {
    return res.status(403).send({ message: "Forbidden" });
  }
  return next();
};

const verifyCustomer = verifyRole("customer");
const verifyTechnician = verifyRole("technician");
const verifyAdmin = verifyRole("admin");

const approvedServiceFilter = {
  approvalStatus: { $in: ["approved", "Approved", "APPROVED"] },
  isAvailable: { $in: [true, "true"] },
};

app.get("/", (req, res) => {
  res.send("Server is running");
});

app.get("/api/services", async (req, res) => {
  try {
    const query = { ...approvedServiceFilter };
    if (req.query.category) {
      query.category = req.query.category;
    }
    const services = await servicesCollection.find(query).toArray();
    return res.send(services);
  } catch (error) {
    return res.status(500).send({ message: "Failed to fetch services" });
  }
});

app.get(
  "/api/services/mine",
  verifyToken,
  verifyTechnician,
  async (req, res) => {
    try {
      const services = await servicesCollection
        .find({ technicianEmail: req.user.email })
        .sort({ createdAt: -1 })
        .toArray();
      return res.send(services);
    } catch (error) {
      return res.status(500).send({ message: "Failed to fetch services" });
    }
  },
);

app.get("/api/services/:id", async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    return res.status(404).send({ message: "Service not found" });
  }

  try {
    const service = await servicesCollection.findOne({
      _id: new ObjectId(req.params.id),
      ...approvedServiceFilter,
    });
    if (!service) {
      return res.status(404).send({ message: "Service not found" });
    }
    return res.send(service);
  } catch (error) {
    return res.status(500).send({ message: "Failed to fetch service" });
  }
});

app.post("/api/bookings", verifyToken, verifyCustomer, async (req, res) => {
  try {
    if (!isValidObjectId(req.body.serviceId)) {
      return res.status(400).send({ message: "Invalid serviceId" });
    }

    const service = await servicesCollection.findOne({
      _id: new ObjectId(req.body.serviceId),
      approvalStatus: { $in: ["approved", "Approved", "APPROVED"] },
      isAvailable: { $in: [true, "true"] },
    });
    if (!service) {
      return res.status(404).send({ message: "Service not found" });
    }

    const booking = {
      serviceId: service._id.toString(),
      serviceTitle: service.title,
      serviceImage: service.serviceImage || service.image,
      category: service.category,
      basePrice: service.basePrice,
      technicianName: service.technicianName,
      technicianEmail: service.technicianEmail,
      customerName: req.user.name,
      customerEmail: req.user.email,
      customerPhone: req.body.customerPhone,
      address: req.body.address,
      preferredDate: req.body.preferredDate,
      problemDescription: req.body.problemDescription,
      status: "requested",
      // The charge must come from the trusted service record, never the client.
      finalAmount: service.basePrice,
      paymentStatus: "unpaid",
      createdAt: new Date(),
    };

    const result = await bookingsCollection.insertOne(booking);
    return res.status(201).send({ ...booking, _id: result.insertedId });
  } catch (error) {
    return res.status(500).send({ message: "Failed to create booking" });
  }
});

app.patch(
  "/api/bookings/:id/cancel",
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    if (!isValidObjectId(req.params.id)) {
      return res.status(404).send({ message: "Booking not found" });
    }

    try {
      const result = await bookingsCollection.updateOne(
        {
          _id: new ObjectId(req.params.id),
          customerEmail: req.user.email,
        },
        { $set: { status: "cancelled", updatedAt: new Date() } },
      );
      if (!result.matchedCount) {
        return res.status(404).send({ message: "Booking not found" });
      }
      return res.send({ matchedCount: result.matchedCount, modifiedCount: result.modifiedCount });
    } catch (error) {
      return res.status(500).send({ message: "Failed to cancel booking" });
    }
  },
);

app.get("/api/bookings/my", verifyToken, verifyCustomer, async (req, res) => {
  try {
    const bookings = await bookingsCollection
      .find({ customerEmail: req.user.email })
      .toArray();
    return res.send(bookings);
  } catch (error) {
    return res.status(500).send({ message: "Failed to fetch bookings" });
  }
});

app.post(
  "/api/payments/create-checkout-session",
  verifyToken,
  verifyCustomer,
  async (req, res) => {
    if (!stripe) {
      return res.status(503).send({ message: "Stripe is not configured" });
    }
    if (!isValidObjectId(req.body.bookingId)) {
      return res.status(400).send({ message: "Invalid bookingId" });
    }

    // Redirects are configured in .env; client-supplied URLs are ignored.
    if (
      !isAllowedRedirectUrl(paymentSuccessUrl) ||
      !isAllowedRedirectUrl(paymentCancelUrl)
    ) {
      return res.status(500).send({ message: "Payment redirects are misconfigured" });
    }

    try {
      const booking = await bookingsCollection.findOne({
        _id: new ObjectId(req.body.bookingId),
        customerEmail: req.user.email,
      });
      if (!booking) {
        return res.status(404).send({ message: "Booking not found" });
      }

      const amount = Number(booking.finalAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).send({ message: "Invalid booking amount" });
      }

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        success_url: paymentSuccessUrl,
        cancel_url: paymentCancelUrl,
        customer_email: req.user.email,
        metadata: {
          bookingId: booking._id.toString(),
          customerId: req.user.id,
        },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: Math.round(amount * 100),
              product_data: {
                name: booking.serviceTitle || "FixMate service",
              },
            },
          },
        ],
      });

      await paymentsCollection.updateOne(
        { bookingId: booking._id.toString() },
        {
          $setOnInsert: {
            bookingId: booking._id.toString(),
            serviceTitle: booking.serviceTitle,
            customerName: req.user.name,
            customerEmail: req.user.email,
            technicianName: booking.technicianName,
            technicianEmail: booking.technicianEmail,
            amount,
            currency: "usd",
            paymentStatus: "unpaid",
            createdAt: new Date(),
          },
          $set: { stripeSessionId: session.id, updatedAt: new Date() },
        },
        { upsert: true },
      );

      return res.send({ url: session.url, sessionId: session.id });
    } catch (error) {
      return res.status(500).send({ message: "Failed to create checkout session" });
    }
  },
);

app.post("/api/payments/confirm", verifyToken, verifyCustomer, async (req, res) => {
  if (!stripe) {
    return res.status(503).send({ message: "Stripe is not configured" });
  }

  const sessionId =
    typeof req.body.sessionId === "string" ? req.body.sessionId.trim() : "";
  if (!sessionId) {
    return res.status(400).send({ message: "Invalid sessionId" });
  }

  try {
    const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);
    const bookingId = checkoutSession.metadata?.bookingId;

    if (!isValidObjectId(bookingId)) {
      return res.status(400).send({ message: "Invalid booking reference" });
    }
    if (checkoutSession.payment_status !== "paid") {
      return res.status(409).send({ message: "Payment is not complete yet" });
    }

    const booking = await bookingsCollection.findOne({
      _id: new ObjectId(bookingId),
      customerEmail: req.user.email,
    });
    if (!booking) {
      return res.status(404).send({ message: "Booking not found" });
    }

    const amount =
      typeof checkoutSession.amount_total === "number"
        ? checkoutSession.amount_total / 100
        : Number(booking.finalAmount) || 0;
    const transactionId =
      typeof checkoutSession.payment_intent === "string"
        ? checkoutSession.payment_intent
        : (checkoutSession.payment_intent?.id ?? "");
    const paidAt = new Date();

    await paymentsCollection.updateOne(
      { bookingId },
      {
        $setOnInsert: {
          bookingId,
          serviceTitle: booking.serviceTitle,
          customerName: booking.customerName,
          customerEmail: booking.customerEmail,
          technicianName: booking.technicianName,
          technicianEmail: booking.technicianEmail,
          amount,
          currency: checkoutSession.currency || "usd",
          createdAt: paidAt,
        },
        $set: {
          paymentStatus: "paid",
          transactionId,
          stripeSessionId: checkoutSession.id,
          paidAt,
          updatedAt: paidAt,
        },
      },
      { upsert: true },
    );

    await bookingsCollection.updateOne(
      { _id: new ObjectId(bookingId), customerEmail: req.user.email },
      { $set: { paymentStatus: "paid", paidAt, updatedAt: paidAt } },
    );

    return res.send({ bookingId, paymentStatus: "paid" });
  } catch (error) {
    return res.status(500).send({ message: "Failed to confirm payment" });
  }
});

app.get("/api/payments", verifyToken, async (req, res) => {
  const role = req.user?.role;
  const filter =
    role === "customer"
      ? { customerEmail: req.user.email }
      : role === "technician"
        ? { technicianEmail: req.user.email }
        : null;

  if (!filter) {
    return res.status(403).send({ message: "Forbidden" });
  }

  try {
    const payments = await paymentsCollection
      .find(filter)
      .sort({ paidAt: -1, createdAt: -1 })
      .toArray();
    return res.send(payments);
  } catch (error) {
    return res.status(500).send({ message: "Failed to fetch payments" });
  }
});

app.post("/api/services", verifyToken, verifyTechnician, async (req, res) => {
  try {
    const service = {
      title: req.body.title,
      category: req.body.category,
      basePrice: req.body.basePrice,
      description: req.body.description,
      estimatedDuration: req.body.estimatedDuration,
      serviceMode: req.body.serviceMode,
      serviceArea: req.body.serviceArea,
      serviceImage: req.body.serviceImage,
      image: req.body.image,
      technicianName: req.user.name,
      technicianEmail: req.user.email,
      status: req.body.status || "active",
      approvalStatus: "pending",
      isAvailable: true,
      createdAt: new Date(),
    };

    const result = await servicesCollection.insertOne(service);
    return res
      .status(201)
      .send({ ...service, _id: result.insertedId, insertedId: result.insertedId });
  } catch (error) {
    return res.status(500).send({ message: "Failed to create service" });
  }
});

app.patch(
  "/api/services/:id",
  verifyToken,
  verifyTechnician,
  async (req, res) => {
    if (!isValidObjectId(req.params.id)) {
      return res.status(404).send({ message: "Service not found" });
    }

    const allowlist = {
      title: req.body.title,
      category: req.body.category,
      basePrice: req.body.basePrice,
      description: req.body.description,
      estimatedDuration: req.body.estimatedDuration,
      serviceMode: req.body.serviceMode,
      serviceArea: req.body.serviceArea,
      serviceImage: req.body.serviceImage,
      image: req.body.image,
      technicianName: req.body.technicianName,
      isAvailable: req.body.isAvailable,
      status: req.body.status,
    };
    const updates = Object.fromEntries(
      Object.entries(allowlist).filter(([, value]) => value !== undefined),
    );
    updates.approvalStatus = "pending";
    updates.updatedAt = new Date();

    try {
      const result = await servicesCollection.updateOne(
        {
          _id: new ObjectId(req.params.id),
          technicianEmail: req.user.email,
        },
        { $set: updates },
      );
      if (!result.matchedCount) {
        return res.status(404).send({ message: "Service not found" });
      }
      return res.send({ matchedCount: result.matchedCount, modifiedCount: result.modifiedCount });
    } catch (error) {
      return res.status(500).send({ message: "Failed to update service" });
    }
  },
);

app.delete(
  "/api/services/:id",
  verifyToken,
  verifyTechnician,
  async (req, res) => {
    if (!isValidObjectId(req.params.id)) {
      return res.status(404).send({ message: "Service not found" });
    }

    try {
      const result = await servicesCollection.deleteOne({
        _id: new ObjectId(req.params.id),
        technicianEmail: req.user.email,
      });
      if (!result.deletedCount) {
        return res.status(404).send({ message: "Service not found" });
      }
      return res.send({ deletedCount: result.deletedCount });
    } catch (error) {
      return res.status(500).send({ message: "Failed to delete service" });
    }
  },
);

app.get(
  "/api/bookings/technician",
  verifyToken,
  verifyTechnician,
  async (req, res) => {
    try {
      const bookings = await bookingsCollection
        .find({ technicianEmail: req.user.email })
        .toArray();
      return res.send(bookings);
    } catch (error) {
      return res.status(500).send({ message: "Failed to fetch bookings" });
    }
  },
);

app.patch(
  "/api/bookings/:id/status",
  verifyToken,
  verifyTechnician,
  async (req, res) => {
    if (!isValidObjectId(req.params.id)) {
      return res.status(404).send({ message: "Booking not found" });
    }

    const status = normalizeBookingStatus(req.body.status);
    if (!validBookingStatuses.has(status)) {
      return res.status(400).send({ message: "Invalid booking status" });
    }

    try {
      const result = await bookingsCollection.updateOne(
        {
          _id: new ObjectId(req.params.id),
          technicianEmail: req.user.email,
        },
        { $set: { status, updatedAt: new Date() } },
      );
      if (!result.matchedCount) {
        return res.status(404).send({ message: "Booking not found" });
      }
      return res.send({ matchedCount: result.matchedCount, modifiedCount: result.modifiedCount });
    } catch (error) {
      return res.status(500).send({ message: "Failed to update booking" });
    }
  },
);

app.patch("/api/users/profile", verifyToken, async (req, res) => {
  // Never include role, email or any other sensitive identity field here.
  const allowlist = {
    name: req.body.name,
    phone: req.body.phone,
    address: req.body.address,
    area: req.body.area,
    bio: req.body.bio,
    image: req.body.image,
  };
  const updates = Object.fromEntries(
    Object.entries(allowlist).filter(([, value]) => value !== undefined),
  );
  updates.updatedAt = new Date();

  try {
    const result = await usersCollection.updateOne(
      { _id: req.user._id },
      { $set: updates },
    );
    if (!result.matchedCount) {
      return res.status(404).send({ message: "User not found" });
    }
    return res.send({ matchedCount: result.matchedCount, modifiedCount: result.modifiedCount });
  } catch (error) {
    return res.status(500).send({ message: "Failed to update profile" });
  }
});

app.get("/api/admin/users", verifyToken, verifyAdmin, async (req, res) => {
  const users = await usersCollection.find({}).toArray();
  return res.send(users);
});

app.patch(
  "/api/admin/users/:id/role",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    if (!isValidObjectId(req.params.id)) {
      return res.status(404).send({ message: "User not found" });
    }
    const role = normalizeRole(req.body.role);
    if (!validRoles.has(role)) {
      return res.status(400).send({ message: "Invalid role" });
    }

    const targetId = new ObjectId(req.params.id);
    if (targetId.equals(req.user._id)) {
      return res.status(403).send({ message: "Administrators cannot change their own role" });
    }

    try {
      const result = await usersCollection.updateOne(
        { _id: targetId },
        { $set: { role: role.charAt(0).toUpperCase() + role.slice(1), updatedAt: new Date() } },
      );
      if (!result.matchedCount) {
        return res.status(404).send({ message: "User not found" });
      }
      return res.send({ matchedCount: result.matchedCount, modifiedCount: result.modifiedCount });
    } catch (error) {
      return res.status(500).send({ message: "Failed to update role" });
    }
  },
);

app.patch(
  "/api/admin/services/:id/approval",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    if (!isValidObjectId(req.params.id)) {
      return res.status(404).send({ message: "Service not found" });
    }
    const approvalStatus = normalizeRole(req.body.approvalStatus);
    if (!["approved", "rejected", "pending"].includes(approvalStatus)) {
      return res.status(400).send({ message: "Invalid approvalStatus" });
    }

    try {
      const result = await servicesCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        {
          $set: {
            approvalStatus,
            isAvailable: approvalStatus === "approved",
            updatedAt: new Date(),
          },
        },
      );
      if (!result.matchedCount) {
        return res.status(404).send({ message: "Service not found" });
      }
      return res.send({ matchedCount: result.matchedCount, modifiedCount: result.modifiedCount });
    } catch (error) {
      return res.status(500).send({ message: "Failed to update approval" });
    }
  },
);

app.get(
  "/api/admin/bookings",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    const bookings = await bookingsCollection.find({}).toArray();
    return res.send(bookings);
  },
);

app.get(
  "/api/admin/payments",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    const payments = await paymentsCollection.find({}).toArray();
    return res.send(payments);
  },
);

app.get("/api/users/profile", verifyToken, async (req, res) => {
  const user = await usersCollection.findOne({ _id: req.user._id });
  if (!user) {
    return res.status(404).send({ message: "User not found" });
  }
  return res.send({
    _id: user._id,
    name: user.name,
    email: user.email,
    role: normalizeRole(user.role),
  });
});

app.use((error, req, res, next) => {
  if (error?.message === "Origin not allowed") {
    return res.status(403).send({ message: "Origin not allowed" });
  }
  return res.status(500).send({ message: "Server error" });
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
