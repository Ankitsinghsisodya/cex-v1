import express from "express";
import { authMiddleware } from "./middleware/auth.middleware"
import authRoutes from "./routes/auth.routes"
import orderRoutes from "./routes/order.routes"
import depthRoutes from "./routes/depth.routes"
import balanceRoutes from "./routes/balance.routes"

export function createApp() {
    const app = express();

    app.use(express.json());

    // /signup and /signin must be registered BEFORE the auth middleware
    // below so they stay reachable without a token.
    app.use(authRoutes);

    // Everything registered after this point requires a valid
    // `authorization` header.
    app.use(authMiddleware);

    app.use(orderRoutes);
    app.use(depthRoutes);
    app.use(balanceRoutes);

    return app;
}
