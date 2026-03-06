const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const session = require('express-session');
const bcryptjs = require('bcryptjs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Session setup
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Database setup
const db = new sqlite3.Database('./database.db', (err) => {
  if (err) console.error('Database connection error:', err);
  else console.log('Connected to SQLite database');
});

// Initialize database tables
function initializeDB() {
  db.serialize(() => {
    // Admin settings table
    db.run(`CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY,
      business_name TEXT,
      whatsapp_number TEXT,
      email TEXT,
      phone TEXT,
      address TEXT,
      about_text TEXT,
      admin_password TEXT
    )`);

    // Products table
    db.run(`CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT,
      name TEXT NOT NULL,
      description TEXT,
      price REAL,
      image_path TEXT,
      features TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Categories table
    db.run(`CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      icon TEXT
    )`);

    // Quotes/Inquiries table
    db.run(`CREATE TABLE IF NOT EXISTS inquiries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_name TEXT,
      customer_email TEXT,
      customer_phone TEXT,
      product_id INTEGER,
      product_name TEXT,
      quantity INTEGER,
      message TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(product_id) REFERENCES products(id)
    )`);

    // Insert default categories if empty
    db.all("SELECT COUNT(*) as count FROM categories", (err, rows) => {
      if (rows && rows[0].count === 0) {
        const defaultCategories = [
          { name: 'Cement', icon: '🏗️' },
          { name: 'Aggregates (Gitti)', icon: '⛏️' },
          { name: 'TMT Rods & Steel', icon: '🔗' },
          { name: 'Paints & Coatings', icon: '🎨' },
          { name: 'Tiles & Marbles', icon: '🛏️' },
          { name: 'Sanitary & Plumbing', icon: '🚰' },
          { name: 'Hardware & Tools', icon: '🔧' }
        ];

        defaultCategories.forEach(cat => {
          db.run("INSERT INTO categories (name, icon) VALUES (?, ?)", [cat.name, cat.icon]);
        });
      }
    });

    // Check if admin password exists, if not create default
    db.get("SELECT * FROM settings LIMIT 1", (err, row) => {
      if (!row) {
        const hash = bcryptjs.hashSync('admin123', 10);
        db.run(`INSERT INTO settings (business_name, whatsapp_number, email, phone, address, about_text, admin_password) 
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ['BuildPro', '+91 XXXXX XXXXX', 'contact@buildpro.in', '+91 XXXXX XXXXX', 'Your City, Your Area', 'Your business description here', hash]
        );
      }
    });
  });
}

initializeDB();

// Multer setup for image uploads
const storage = multer.memoryStorage();
const upload = multer({ storage });

// ============ PUBLIC ROUTES ============

// Home page
app.get('/', (req, res) => {
  const query = `
    SELECT c.*, 
           (SELECT COUNT(*) FROM products p WHERE p.category = c.name) as product_count
    FROM categories c
  `;
  
  db.all(query, (err, categories) => {
    db.get("SELECT * FROM settings LIMIT 1", (err, settings) => {
      res.render('index', { categories, settings: settings || {} });
    });
  });
});

// Get all products (API)
app.get('/api/products', (req, res) => {
  const category = req.query.category;
  let query = 'SELECT * FROM products';
  
  if (category && category !== 'All') {
    query += ' WHERE category = ?';
    db.all(query, [category], (err, products) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(products);
    });
  } else {
    db.all(query, (err, products) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(products);
    });
  }
});

// Get single product
app.get('/api/products/:id', (req, res) => {
  db.get("SELECT * FROM products WHERE id = ?", [req.params.id], (err, product) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json(product);
  });
});

// Create inquiry/quote
app.post('/api/inquiries', (req, res) => {
  const { customer_name, customer_email, customer_phone, product_id, product_name, quantity, message } = req.body;
  
  db.run(`INSERT INTO inquiries (customer_name, customer_email, customer_phone, product_id, product_name, quantity, message)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [customer_name, customer_email, customer_phone, product_id, product_name, quantity, message],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, success: true, message: 'Inquiry submitted successfully' });
    }
  );
});

// Get settings (for client)
app.get('/api/settings', (req, res) => {
  db.get("SELECT business_name, whatsapp_number, email, phone, address FROM settings LIMIT 1", (err, settings) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(settings || {});
  });
});

// ============ ADMIN ROUTES ============

// Admin login page
app.get('/admin', (req, res) => {
  if (req.session.admin) return res.redirect('/admin/dashboard');
  res.render('admin/login');
});

// Admin login
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  
  db.get("SELECT admin_password FROM settings LIMIT 1", (err, row) => {
    if (!row || !bcryptjs.compareSync(password, row.admin_password)) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    req.session.admin = true;
    res.json({ success: true });
  });
});

// Admin logout
app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin');
});

// Dashboard
app.get('/admin/dashboard', (req, res) => {
  if (!req.session.admin) return res.redirect('/admin');
  
  db.all("SELECT * FROM products ORDER BY created_at DESC", (err, products) => {
    db.get("SELECT * FROM settings LIMIT 1", (err, settings) => {
      db.all("SELECT COUNT(*) as pending FROM inquiries WHERE status = 'pending'", (err, inquiries) => {
        res.render('admin/dashboard', { 
          products, 
          settings: settings || {},
          pendingCount: inquiries[0]?.pending || 0
        });
      });
    });
  });
});

// Get all inquiries
app.get('/admin/inquiries', (req, res) => {
  if (!req.session.admin) return res.status(403).json({ error: 'Not authorized' });
  
  db.all("SELECT * FROM inquiries ORDER BY created_at DESC", (err, inquiries) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(inquiries);
  });
});

// Update inquiry status
app.put('/admin/inquiries/:id', (req, res) => {
  if (!req.session.admin) return res.status(403).json({ error: 'Not authorized' });
  
  const { status } = req.body;
  db.run("UPDATE inquiries SET status = ? WHERE id = ?", [status, req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Add product
app.post('/admin/products', upload.single('image'), async (req, res) => {
  if (!req.session.admin) return res.status(403).json({ error: 'Not authorized' });
  
  try {
    const { category, name, description, price, features } = req.body;
    let image_path = null;

    // Process image if uploaded
    if (req.file) {
      const filename = `product_${Date.now()}.jpg`;
      const filepath = path.join(__dirname, 'public/uploads', filename);
      
      // Resize to 400x300 (good for product cards)
      await sharp(req.file.buffer)
        .resize(400, 300, { fit: 'cover' })
        .jpeg({ quality: 80 })
        .toFile(filepath);
      
      image_path = `/uploads/${filename}`;
    }

    db.run(`INSERT INTO products (category, name, description, price, image_path, features)
            VALUES (?, ?, ?, ?, ?, ?)`,
      [category, name, description, price, image_path, features],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, success: true });
      }
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update product
app.put('/admin/products/:id', upload.single('image'), async (req, res) => {
  if (!req.session.admin) return res.status(403).json({ error: 'Not authorized' });
  
  try {
    const { category, name, description, price, features } = req.body;
    let image_path = null;

    if (req.file) {
      const filename = `product_${Date.now()}.jpg`;
      const filepath = path.join(__dirname, 'public/uploads', filename);
      
      await sharp(req.file.buffer)
        .resize(400, 300, { fit: 'cover' })
        .jpeg({ quality: 80 })
        .toFile(filepath);
      
      image_path = `/uploads/${filename}`;
    }

    const updateQuery = image_path 
      ? `UPDATE products SET category=?, name=?, description=?, price=?, image_path=?, features=? WHERE id=?`
      : `UPDATE products SET category=?, name=?, description=?, price=?, features=? WHERE id=?`;
    
    const params = image_path 
      ? [category, name, description, price, image_path, features, req.params.id]
      : [category, name, description, price, features, req.params.id];

    db.run(updateQuery, params, (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete product
app.delete('/admin/products/:id', (req, res) => {
  if (!req.session.admin) return res.status(403).json({ error: 'Not authorized' });
  
  db.run("DELETE FROM products WHERE id = ?", [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Update settings
app.put('/admin/settings', (req, res) => {
  if (!req.session.admin) return res.status(403).json({ error: 'Not authorized' });
  
  const { business_name, whatsapp_number, email, phone, address, about_text, new_password } = req.body;
  
  let query = `UPDATE settings SET business_name=?, whatsapp_number=?, email=?, phone=?, address=?, about_text=?`;
  let params = [business_name, whatsapp_number, email, phone, address, about_text];
  
  if (new_password && new_password.trim()) {
    const hash = bcryptjs.hashSync(new_password, 10);
    query += `, admin_password=?`;
    params.push(hash);
  }
  
  db.run(query, params, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Serve images
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`📊 Admin panel at http://localhost:${PORT}/admin`);
});
