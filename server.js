// Top of file (already present)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const { createServer } = require('http');
const WebSocket = require('ws');
const app = express();

// Allowed Origins
const allowedOrigins = [
  'https://thriving-naiad-ddffca.netlify.app',
  process.env.FRONTEND_URL
].filter(Boolean);

// CORS Middleware
app.use(cors({
  origin: function (origin, callback) {
    console.log('Incoming Origin:', origin);
    if (!origin) return callback(null, true);

    const isLocalhost = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
    const isAllowed = allowedOrigins.includes(origin);
    if (isLocalhost || isAllowed) return callback(null, true);

    console.warn('❌ Blocked by CORS:', origin);
    return callback(new Error('Not allowed by CORS: ' + origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10kb' }));

// Constants
const PORT = process.env.PORT || 3002;
const HOST = '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const OTP_FILE = path.join(DATA_DIR, 'otp_store.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json'); // ✅ New

const server = createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Map();

// WebSocket
wss.on('connection', (ws, req) => {
  const clientId = uuidv4();
  console.log(`Client connected: ${clientId}`);

  ws.send(JSON.stringify({
    type: 'connection',
    status: 'success',
    clientId,
    timestamp: new Date().toISOString()
  }));

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);
      if (message.type === 'subscribe') {
        clients.set(clientId, {
          ws,
          group: message.group,
          walletAddress: message.walletAddress || null,
          senderId: message.senderId || clientId
        });
        return;
      }

      if (message.type === 'message') {
        const fullMessage = {
          id: uuidv4(),
          type: 'message',
          text: message.text,
          sender: message.sender,
          senderId: message.senderId,
          group: message.group,
          timestamp: new Date().toISOString(),
          status: 'delivered'
        };

        await saveMessage(fullMessage);
        clients.forEach(client => {
          if (client.group === message.group && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(fullMessage));
          }
        });
      }
    } catch (err) {
      console.error('WS message error:', err);
    }
  });

  ws.on('close', () => clients.delete(clientId));
  ws.on('error', (err) => console.error(`WS error for ${clientId}:`, err));
});

// Storage Initialization
const initializeStorage = async () => {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    if (!(await fileExists(OTP_FILE))) await fs.writeFile(OTP_FILE, '{}');
    if (!(await fileExists(MESSAGES_FILE))) await fs.writeFile(MESSAGES_FILE, '[]');
    if (!(await fileExists(GROUPS_FILE))) await fs.writeFile(GROUPS_FILE, '[]'); // ✅ New
  } catch (err) {
    console.error('Storage init error:', err);
    process.exit(1);
  }
};

const fileExists = async (path) => {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
};

// Email Setup
const transporter = nodemailer.createTransport({
  service: process.env.EMAIL_SERVICE || 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// OTP Logic
let otpStorage = {};
const generateOTP = () => crypto.randomInt(100000, 999999).toString();

const loadOtps = async () => {
  try {
    const data = await fs.readFile(OTP_FILE, 'utf8');
    otpStorage = JSON.parse(data || '{}');
  } catch (err) {
    console.error('Error loading OTPs:', err);
  }
};

const saveOtps = async () => {
  try {
    await fs.writeFile(OTP_FILE, JSON.stringify(otpStorage, null, 2));
  } catch (err) {
    console.error('Error saving OTPs:', err);
  }
};

// Message Logic
const saveMessage = async (message) => {
  try {
    const messages = JSON.parse(await fs.readFile(MESSAGES_FILE, 'utf8') || '[]');
    messages.push(message);
    await fs.writeFile(MESSAGES_FILE, JSON.stringify(messages, null, 2));
  } catch (err) {
    console.error('Error saving message:', err);
    throw err;
  }
};

const getMessages = async (group) => {
  try {
    const messages = JSON.parse(await fs.readFile(MESSAGES_FILE, 'utf8') || '[]');
    return messages.filter(m => m.group === group);
  } catch (err) {
    console.error('Error reading messages:', err);
    throw err;
  }
};

// === ✅ Group Logic ===
app.post('/api/groups', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({ error: 'Invalid group name' });
    }

    const groups = JSON.parse(await fs.readFile(GROUPS_FILE, 'utf8') || '[]');
    const newGroup = {
      id: uuidv4(),
      name: name.trim(),
      createdAt: new Date().toISOString()
    };

    groups.push(newGroup);
    await fs.writeFile(GROUPS_FILE, JSON.stringify(groups, null, 2));
    res.status(201).json(newGroup);
  } catch (err) {
    console.error('Group creation error:', err);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

app.get('/api/groups', async (req, res) => {
  try {
    const data = await fs.readFile(GROUPS_FILE, 'utf8');
    const groups = JSON.parse(data || '[]');
    res.json(groups);
  } catch (err) {
    console.error('Group fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

// === API Routes ===
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    websocket: {
      clients: clients.size,
      groups: [...new Set([...clients.values()].map(c => c.group))]
    }
  });
});

app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email required' });
    }

    const otp = generateOTP();
    otpStorage[email] = {
      otp,
      expiresAt: Date.now() + 300000,
      attempts: 0
    };
    await saveOtps();

    await transporter.sendMail({
      from: `Your App <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Your Verification Code',
      text: `Your OTP code is: ${otp}\nExpires in 5 minutes`
    });

    res.json({ success: true, message: 'OTP sent' });
  } catch (err) {
    console.error('OTP send error:', err);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'Email and OTP required' });

    const stored = otpStorage[email];
    if (!stored) return res.status(400).json({ error: 'OTP not found' });

    if (Date.now() > stored.expiresAt) {
      delete otpStorage[email];
      await saveOtps();
      return res.status(400).json({ error: 'OTP expired' });
    }

    if (stored.otp !== otp) {
      stored.attempts = (stored.attempts || 0) + 1;
      if (stored.attempts >= 3) {
        delete otpStorage[email];
        await saveOtps();
        return res.status(400).json({ error: 'Too many attempts' });
      }
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    delete otpStorage[email];
    await saveOtps();
    res.json({ success: true, token: uuidv4(), user: { email } });
  } catch (err) {
    console.error('OTP verification error:', err);
    res.status(500).json({ error: 'Failed to verify OTP' });
  }
});

app.post('/api/messages', async (req, res) => {
  try {
    const message = {
      ...req.body,
      id: uuidv4(),
      timestamp: new Date().toISOString()
    };
    await saveMessage(message);
    clients.forEach(client => {
      if (client.group === message.group && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(message));
      }
    });
    res.status(201).json(message);
  } catch (err) {
    console.error('Message save error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

app.get('/api/messages/:group', async (req, res) => {
  try {
    const messages = await getMessages(req.params.group);
    res.json(messages);
  } catch (err) {
    console.error('Message fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Start Server
const startServer = async () => {
  await initializeStorage();
  await loadOtps();
  server.listen(PORT, HOST, () => {
    console.log(`\n🚀 Server ready at http://${HOST}:${PORT}\n💬 WebSocket running on ws://${HOST}:${PORT}`);
  });
};

startServer().catch(err => {
  console.error('Server startup failed:', err);
  process.exit(1);
});
