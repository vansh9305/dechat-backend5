require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const otpGenerator = require('otp-generator');
const nodemailer = require('nodemailer');
const fs = require('fs');

const app = express();

// ===== Constants =====
const PORT = process.env.PORT || 3002;
const HOST = process.env.HOST || 'localhost';
const OTP_FILE = 'otp_store.json';

// ===== OTP Storage =====
let otpStorage = new Map();

// Load persisted OTPs on startup
if (fs.existsSync(OTP_FILE)) {
  try {
    const storedOtps = JSON.parse(fs.readFileSync(OTP_FILE));
    otpStorage = new Map(storedOtps);
    console.log(`Loaded ${otpStorage.size} OTPs from storage`);
  } catch (err) {
    console.error('Error loading OTP storage:', err);
  }
}

// ===== Middleware =====
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json({
  verify: (req, res, buf) => {
    try {
      JSON.parse(buf.toString('utf8'));
    } catch (e) {
      console.error('Invalid JSON:', buf.toString('utf8'));
      throw new Error('Invalid JSON format');
    }
  },
  strict: true
}));

app.use((req, res, next) => {
  console.log(`\n[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ===== Email Setup =====
const transporter = nodemailer.createTransport({
  service: 'gmail',
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  tls: {
    rejectUnauthorized: false,
    ciphers: 'SSLv3'
  }
});

// ===== Routes =====
const router = express.Router();

// Health Check
app.get('/', (req, res) => {
  res.json({
    status: 'Server is running',
    endpoints: {
      sendOTP: 'POST /api/auth/send-otp',
      verifyOTP: 'POST /api/auth/verify-otp',
      testEmail: 'GET /test-email',
      activeOTPs: 'GET /active-otps'
    }
  });
});

// OTP Endpoints
router.post('/send-otp', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const otp = otpGenerator.generate(6, {
      upperCaseAlphabets: false,
      specialChars: false,
      lowerCaseAlphabets: false
    });

    const otpData = { 
      otp, 
      expires: Date.now() + 300000,
      generatedAt: new Date().toISOString()
    };
    
    otpStorage.set(email, otpData);
    fs.writeFileSync(OTP_FILE, JSON.stringify([...otpStorage]));

    if (process.env.EMAIL_USER) {
      await transporter.sendMail({
        from: `"DeChat App" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Your OTP Code',
        text: `Your OTP is: ${otp}`,
        html: `<b>${otp}</b>`
      });
    }

    res.json({ 
      success: true,
      debug: process.env.NODE_ENV !== 'production' ? { otp } : undefined
    });

  } catch (error) {
    console.error('OTP Error:', error);
    res.status(500).json({ 
      error: 'Failed to send OTP',
      ...(process.env.NODE_ENV !== 'production' && { details: error.message })
    });
  }
});

router.post('/verify-otp', (req, res) => {
  try {
    const { email, otp } = req.body;
    
    if (!otpStorage.has(email)) {
      return res.status(400).json({ error: 'OTP expired or not requested' });
    }

    const stored = otpStorage.get(email);
    
    if (Date.now() > stored.expires) {
      otpStorage.delete(email);
      fs.writeFileSync(OTP_FILE, JSON.stringify([...otpStorage]));
      return res.status(400).json({ error: 'OTP expired' });
    }

    if (stored.otp !== otp) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    otpStorage.delete(email);
    fs.writeFileSync(OTP_FILE, JSON.stringify([...otpStorage]));
    res.json({ success: true });
  } catch (error) {
    console.error('Verify Error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Test Endpoints
app.get('/test-email', async (req, res) => {
  if (!process.env.EMAIL_USER) {
    return res.status(400).json({ error: 'Email not configured' });
  }

  try {
    const info = await transporter.sendMail({
      from: `"Test" <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_USER,
      subject: 'Test Email',
      text: 'This is a test email'
    });
    res.json({ success: true, messageId: info.messageId });
  } catch (error) {
    res.status(500).json({ 
      error: 'Email failed',
      details: error.message
    });
  }
});

app.get('/active-otps', (req, res) => {
  res.json(Array.from(otpStorage.entries()).map(([email, data]) => ({
    email,
    otp: data.otp,
    expiresIn: Math.round((data.expires - Date.now())/1000) + "s",
    status: Date.now() > data.expires ? 'EXPIRED' : 'ACTIVE'
  })));
});

// Mount router
app.use('/api/auth', router);

// Error Handling
app.use((err, req, res, next) => {
  console.error('Server Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ===== Server Startup =====
app.listen(PORT, HOST, () => {
  console.log(`
███████╗ ██████╗ ██████╗  ██████╗ ██████╗ 
██╔════╝██╔═══██╗██╔══██╗██╔═══██╗██╔══██╗
█████╗  ██║   ██║██████╔╝██║   ██║██████╔╝
██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔═══╝ 
██║     ╚██████╔╝██║  ██║╚██████╔╝██║     
╚═╝      ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═╝     
                                          
🚀 Server running on http://${HOST}:${PORT}

📋 Available Endpoints:
  POST   /api/auth/send-otp
  POST   /api/auth/verify-otp
  GET    /test-email
  GET    /active-otps

🔧 Email Status: ${process.env.EMAIL_USER ? '✅ Configured' : '❌ Disabled'}
`);
});