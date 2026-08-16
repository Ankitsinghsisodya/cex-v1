import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
    try {
        const token = req.headers["authorization"];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: "The user is not authenticated"
            })
        }
        if (!process.env.SECRET) {
            throw new Error("jwt secret in not availabe")
        }
        const decode = jwt.verify(token, process.env.SECRET);

        
        if (typeof decode === "string") {
            return res.status(401).json({
                success: false,
                message: "Invalid token"
            })
        }
     
        req.userId = decode.userId;

        next();
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Server side error"
        })
    }
}
