import express from "express";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "./util"
import jwt from "jsonwebtoken";
import { Side, Side, Status } from "./generated/enums";


const app = express();

app.use(express.json());

const BALANCES = {

}

const ORDERBOOKS: OrderBook = {
    SOL: {
        ASK:{},
        BID:{}
    },
    BTC: {
        ASK:{},
        BID:{}
    }
}

type OrderEntry = {
    userId : number, 
    qty: number, 
    filledQty: number, 
    orderId: number,
}

type PriceLevel = {
    totalQty: number,
    Ordres: OrderEntry[]
}

type stockOrderBook = {
    ASK: {[price:number] : PriceLevel},
    BID: {[price:number] : PriceLevel}
}

type OrderBook = {
    [symbol: string] : stockOrderBook
}


/*
    username
    password
*/
app.post("/signup", async (req: Request, res: Response) => {
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

        return res.status(201).json({
            success: true,
            message: "User is created successfully",
            user: {
                id: newUser.id,
                username: newUser.username
            }
        })
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Server side error"
        })
    }
})

app.post("/signin", async (req, res) => {
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

app.use(async(req: Request, res: Response, next:NextFunction) => {
    try {
        const token = req.headers["authorization"];

        if(!token){
            return res.status(401).json({
                success: false,
                message: "The user is not authenticated"
            })
        }
        if(!process.env.SECRET){
            throw new Error("jwt secret in not availabe")
        }
        const decode = jwt.verify(token, process.env.SECRET);

        if(typeof decode === "string"){
            return res.status(401).json({
                success:false,
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
})
/*
    body = {
        type:           "market" | "limit",
        price:          number | null,
        qty:            number,
        market_id:      string,
        side:           "buy" | "sell"
    }

    @returns {
        orderId: string,
        filledQty: number,
        averagePrice
    }
*/

// 50.01

function updateORDERBOOKState(): {

}


// 500001
app.post("/order", async (req: Request, res: Response) => {
    try {
        const {
            type, price, qty, market_id, side
        } = req.body;
        const userId = req.userId!;
        // save an order

        const stock = await prisma.stocks.findFirst({
            where:{
                symbol: market_id
            }
        })

        if(!stock){
            return res.status(400).json({
                success:false,
                message: "Invalid stock"
            })
        }

        const order = await prisma.order.create({
            data:{
                userId,
                side,
                type,
                stockId: stock.id , 
                price,
                qty,
                filledQty:0,
                status:Status.EMPTY
            }
        })
        let sideEnum = (side == "ASK")? Side.ASK:Side.BID;
        ORDERBOOKS[stock.symbol][side]
        // filledQty


    } catch (error) {
        res.status(500).json({
            success:false,
            message: "Server side error"
        })
    }
})
/*
    returns the status of an order (partially filled, success, cancellled)
    ALSO RETURNS THE INDIVIDUAL FILLS OF THIS ORDER 
*/
app.get("/order/:orderId")
app.delete("/order/:orderId")
app.get("/depth/:symbol");
app.get("/orders");
app.get("/fills");

app.get("/balance/usd");

/*  
    Returns the balance of all stocks
*/
app.get("/balance")

app.listen(3000);