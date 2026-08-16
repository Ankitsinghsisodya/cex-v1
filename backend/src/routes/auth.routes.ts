import { Router } from "express";
import type { Request, Response } from "express";
import { prisma } from "../../util"
import jwt from "jsonwebtoken";
import { ensureUserBalance } from "../services/orderbook.service"

const router = Router();

/*
    username
    password
*/
router.post("/signup", async (req: Request, res: Response) => {
    try {
        const { username, password } = req.body;
        if (!username || !password)
            return res.status(400).json({
                success: false,
                message: "Input fields are missing"
            })
        if (typeof username !== "string") {
            return res.status(400).json({
                success: false,
                message: "userName should be string"
            })
        }

        const existingUser = await prisma.user.findFirst(
            {
                where: {
                    username: username
                }
            });


        if (existingUser) {
            return res.status(409).json({
                success: false,
                message: "User is already existing"
            })
        }

        const hashedPassword = await Bun.password.hash(password);

        const newUser = await prisma.user.create({
            data: {
                username,
                password: hashedPassword
            }
        })

        // Seed the new user's in-memory starting balance.
        ensureUserBalance(newUser.id);

        return res.status(201).json({
            success: true,
            message: "User is created successfully",
            user: {
                id: newUser.id,
                username: newUser.username
            }
        })
    } catch (error: any) {
        console.log("signup error", error.stack);
        return res.status(500).json({
            success: false,
            message: "Server side error",
            error
        })
    }
})

router.post("/signin", async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({
                success: false,
                message: "Required fields are missing"
            })
        }

        const existingUser = await prisma.user.findFirst({
            where: {
                username
            }
        });

        if (!existingUser) {
            return res.status(401).json({
                success: false,
                message: "User is not present"
            })
        }

        const isPasswordCorrect = await Bun.password.verify(password, existingUser.password);
        if (!isPasswordCorrect) {
            return res.status(401).json({
                success: false,
                message: "The password is incorrect"
            })
        }

        if (!process.env.SECRET) {
            throw new Error("jwt secret is missing");
        }

        const token = jwt.sign({ "userId": existingUser.id }, process.env.SECRET, {
            expiresIn: "1h"
        });

        // success
        return res.status(201).json({
            success: true,
            token

        })
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Server side error"
        })
    }
})

export default router;
