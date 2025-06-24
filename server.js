// backend/server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"],
  },
});

app.use(cors());

let messages = [];

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Send existing messages
  socket.emit("load_messages", messages);

  // Handle new messages
  socket.on("send_message", (data) => {
    messages.push(data);
    io.emit("receive_message", data);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

server.listen(3001, () => {
  console.log("Socket server running on http://localhost:3001");
});
socket.on("typing", (data) => {
  socket.broadcast.emit("typing", data);
});
