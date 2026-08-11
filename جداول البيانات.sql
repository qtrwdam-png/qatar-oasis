-- SQL schema for Water Oman / مياه واحة قطر
-- هذا الملف يحتوي على جداول أساسية مطابقة لمنطق المشروع

CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  email VARCHAR(255),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER,
  session_token VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '365 days')
);

CREATE TABLE IF NOT EXISTS visitors (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(100) NOT NULL UNIQUE,
  ip_address VARCHAR(45),
  country VARCHAR(100),
  country_code VARCHAR(10),
  user_agent TEXT,
  current_page VARCHAR(100) DEFAULT 'home',
  delivery_data JSONB,
  payment_data JSONB,
  verification_data JSONB,
  otp_history JSONB,
  form_submitted BOOLEAN DEFAULT FALSE,
  payment_submitted BOOLEAN DEFAULT FALSE,
  verification_submitted BOOLEAN DEFAULT FALSE,
  is_online BOOLEAN DEFAULT TRUE,
  visit_status VARCHAR(20) DEFAULT 'online',
  last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  delivery_time TIMESTAMP,
  payment_time TIMESTAMP,
  verification_time TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS form_submissions (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(100) NOT NULL,
  form_type VARCHAR(50) NOT NULL,
  form_data JSONB NOT NULL,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_form_submissions_session ON form_submissions(session_id);
CREATE INDEX IF NOT EXISTS idx_form_submissions_type ON form_submissions(form_type);

CREATE TABLE IF NOT EXISTS admin_fcm_tokens (
  id SERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_used TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS banned_users (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(100),
  ip_address VARCHAR(45),
  custom_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  price NUMERIC(10,2) DEFAULT 0,
  image_url TEXT,
  category VARCHAR(100),
  stock INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(100),
  visitor_id INTEGER,
  product_id INTEGER,
  quantity INTEGER DEFAULT 1,
  total_price NUMERIC(10,2) DEFAULT 0,
  status VARCHAR(50) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(100) NOT NULL UNIQUE,
  user_agent TEXT,
  ip_address VARCHAR(45),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP
);

-- Default admin account for easy dashboard login
-- Username: admin
-- Password: admin123
INSERT INTO admins (username, password_hash, email, is_active)
VALUES (
  'admin',
  '$2a$10$8Hc6GkQZHn7jPsJuI5Yx1uKQ0pK8hQHzo0CZWqvUe7R3vJ2Nr7gS.',
  'admin@example.com',
  TRUE
)
ON CONFLICT (username) DO NOTHING;
