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

const allowedOrigins = [
  'https://candid-mousse-75e4d8.netlify.app/',
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    console.log('Incoming Origin:', origin);

    if (!origin) return callback(null, true); // Allow non-browser tools like Postman

    const isLocalhost = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
    const isAllowed = allowedOrigins.includes(origin);

    if (isLocalhost || isAllowed) {
      return callback(null, true);
    } else {
      console.warn('❌ Blocked by CORS:', origin);
      return callback(new Error('Not allowed by CORS: ' + origin));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10kb' }));

// ===== Constants =====
const PORT = process.env.PORT || 3002;
const HOST = '0.0.0.0'; // Updated for Render compatibility
const DATA_DIR = path.join(__dirname, 'data');
const OTP_FILE = path.join(DATA_DIR, 'otp_store.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');

// ===== WebSocket Setup =====
const server = createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Map();

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
          walletAddress: message.walletAddress || null
        });
        return;
      }

      if (message.type === 'message') {
        const fullMessage = {
          ...message,
          id: uuidv4(),
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

  ws.on('close', () => {
    clients.delete(clientId);
  });

  ws.on('error', (err) => {
    console.error(`WS error for ${clientId}:`, err);
  });
});

// ===== Storage Setup =====
const initializeStorage = async () => {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    if (!(await fileExists(OTP_FILE))) await fs.writeFile(OTP_FILE, '{}');
    if (!(await fileExists(MESSAGES_FILE))) await fs.writeFile(MESSAGES_FILE, '[]');
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

// ===== Email Setup =====
const transporter = nodemailer.createTransport({
  service: process.env.EMAIL_SERVICE || 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// ===== OTP Management =====
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

// ===== Message Storage =====
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

// ===== Routes =====
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
      from: `"Your App" <${process.env.EMAIL_USER}>`,
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
    
    res.json({
      success: true,
      token: uuidv4(),
      user: { email }
    });
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

// ===== Server Initialization =====
const startServer = async () => {
  await initializeStorage();
  await loadOtps();

  server.listen(PORT, HOST, () => {
    console.log(`
      🚀 Server ready at http://${HOST}:${PORT}
      💬 WebSocket running on ws://${HOST}:${PORT}
    `);
  });
};

startServer().catch(err => {
  console.error('Server startup failed:', err);
  process.exit(1);
});