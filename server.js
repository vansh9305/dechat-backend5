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

// ===== Constants =====
const PORT = process.env.PORT || 3002;
const HOST = process.env.HOST || '0.0.0.0'; // Changed for Render compatibility
const DATA_DIR = path.join(__dirname, 'data');
const OTP_FILE = path.join(DATA_DIR, 'otp_store.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');

// ===== WebSocket Setup =====
const server = createServer(app);
const wss = new WebSocket.Server({ 
  server,
  perMessageDeflate: {
    zlibDeflateOptions: {
      chunkSize: 1024,
      memLevel: 7,
      level: 3
    },
    zlibInflateOptions: {
      chunkSize: 10 * 1024
    },
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    threshold: 1024
  }
});

// Track connected clients and their groups
const clients = new Map();

wss.on('connection', (ws, req) => {
  const clientId = uuidv4();
  console.log(`Client connected: ${clientId} from ${req.socket.remoteAddress}`);

  // Send immediate connection confirmation
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
        console.log(`Client ${clientId} subscribed to ${message.group}`);
        return;
      }

      if (message.type === 'message') {
        const fullMessage = {
          ...message,
          id: uuidv4(),
          timestamp: new Date().toISOString(),
          status: 'delivered'
        };

        console.log(`Message in ${message.group} from ${message.sender || 'anon'}`);

        await saveMessage(fullMessage);

        // Broadcast to group members
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
    console.log(`Client ${clientId} disconnected`);
  });

  ws.on('error', (err) => {
    console.error(`WS error for ${clientId}:`, err);
  });
});

// ===== Storage Setup =====
const initializeStorage = async () => {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    
    const files = [OTP_FILE, MESSAGES_FILE];
    for (const file of files) {
      if (!(await fileExists(file))) {
        await fs.writeFile(file, '[]');
      }
    }
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
  },
  tls: {
    rejectUnauthorized: process.env.NODE_ENV === 'production'
  }
});

// ===== Secure OTP Generation =====
const generateNumericOTP = (length = 6) => {
  const digits = '0123456789';
  let otp = '';
  const randomBytes = crypto.randomBytes(length);
  
  for (let i = 0; i < length; i++) {
    otp += digits[randomBytes[i] % digits.length];
  }
  
  return otp;
};

// ===== Middleware =====
app.use(cors({
  origin: process.env.FRONTEND_URL || '*', // Temporary open for testing
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS']
}));

app.use(express.json({ limit: '10kb' }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ===== OTP Storage =====
let otpStorage = new Map();

const loadOtps = async () => {
  try {
    const data = await fs.readFile(OTP_FILE, 'utf8');
    otpStorage = new Map(JSON.parse(data || '[]'));
  } catch (err) {
    console.error('Error loading OTPs:', err);
  }
};

const saveOtps = async () => {
  try {
    await fs.writeFile(OTP_FILE, JSON.stringify([...otpStorage]));
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
    },
    memory: process.memoryUsage()
  });
});

app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const otp = generateNumericOTP();
    otpStorage.set(email, { 
      otp, 
      expiresAt: Date.now() + 300000 // 5 mins
    });
    await saveOtps();

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Your OTP Code',
      text: `Your OTP is: ${otp} (expires in 5 minutes)`
    });
    
    res.json({ success: true });
  } catch (err) {
    console.error('OTP send error:', err);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'Email and OTP required' });

    const stored = otpStorage.get(email);
    if (!stored) return res.status(400).json({ error: 'OTP not found' });

    if (Date.now() > stored.expiresAt) {
      otpStorage.delete(email);
      await saveOtps();
      return res.status(400).json({ error: 'OTP expired' });
    }

    if (stored.otp !== otp) return res.status(400).json({ error: 'Invalid OTP' });

    otpStorage.delete(email);
    await saveOtps();
    res.json({ success: true, token: uuidv4() });
  } catch (err) {
    console.error('OTP verify error:', err);
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

    // Broadcast via WS
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
      
      ⚠️  For Render deployment:
      1. Set FRONTEND_URL in environment variables
      2. Enable "WebSockets" in Render dashboard
      3. Set NODE_ENV=production
    `);
  });

  process.on('SIGTERM', () => {
    console.log('Shutting down gracefully...');
    wss.clients.forEach(client => client.close());
    server.close(() => process.exit(0));
  });
};

startServer().catch(err => {
  console.error('Server startup failed:', err);
  process.exit(1);
});