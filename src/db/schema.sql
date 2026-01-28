-- Core restaurant info
CREATE TABLE IF NOT EXISTS restaurants (
  id TEXT PRIMARY KEY,
  name TEXT,
  tagline TEXT,
  description TEXT,
  cuisine_type TEXT,
  address TEXT,
  phone TEXT,
  email TEXT,
  website_url TEXT,
  hours_json TEXT, -- JSON: {"mon": "9am-10pm", ...}
  primary_image_path TEXT,
  logo_path TEXT,
  style_theme TEXT DEFAULT 'modern', -- 'modern', 'rustic', 'vibrant'
  primary_color TEXT DEFAULT '#2563eb',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Menu structure
CREATE TABLE IF NOT EXISTS menu_categories (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  display_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS menu_items (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price REAL,
  image_path TEXT,
  is_featured INTEGER DEFAULT 0,
  dietary_tags_json TEXT, -- JSON array: ["vegetarian", "gluten-free"]
  display_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES menu_categories(id) ON DELETE CASCADE
);

-- Photo gallery
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  path TEXT NOT NULL,
  caption TEXT,
  type TEXT DEFAULT 'food', -- 'food', 'interior', 'exterior', 'menu'
  is_primary INTEGER DEFAULT 0,
  display_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);

-- Generated materials tracking
CREATE TABLE IF NOT EXISTS generated_materials (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  type TEXT NOT NULL, -- 'website', 'brochure_pdf', 'brochure_image'
  file_path TEXT,
  cloudflare_url TEXT,
  version INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);

-- Processing jobs
CREATE TABLE IF NOT EXISTS processing_jobs (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT,
  video_path TEXT,
  status TEXT DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
  progress INTEGER DEFAULT 0,
  error_message TEXT,
  missing_fields_json TEXT, -- JSON array of missing required fields
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Notes (announcements, special info, etc.)
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  content TEXT NOT NULL,
  expires_at TEXT, -- ISO date, NULL = never expires
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notes_restaurant ON notes(restaurant_id);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_menu_categories_restaurant ON menu_categories(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_category ON menu_items(category_id);
CREATE INDEX IF NOT EXISTS idx_photos_restaurant ON photos(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_materials_restaurant ON generated_materials(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_jobs_restaurant ON processing_jobs(restaurant_id);

-- Shorts processing jobs
CREATE TABLE IF NOT EXISTS shorts_jobs (
  id TEXT PRIMARY KEY,
  video_path TEXT NOT NULL,
  status TEXT DEFAULT 'pending', -- 'pending', 'processing', 'ready', 'uploaded', 'failed'
  progress INTEGER DEFAULT 0,
  progress_stage TEXT, -- 'analyzing', 'clip_extracted', 'script_ready', 'voiceover_done', 'audio_mixed', 'ready'
  error_message TEXT,

  -- Clip selection results
  clip_start REAL, -- Start time in seconds
  clip_end REAL, -- End time in seconds
  clip_path TEXT, -- Extracted clip path

  -- Voiceover results
  script TEXT, -- Generated voiceover script
  voiceover_path TEXT, -- Generated audio path

  -- Final output
  output_path TEXT, -- Final shorts-format video (narrated version)
  output_path_asmr TEXT, -- ASMR version (cooking sounds only, no voiceover)
  thumbnail_path TEXT,

  -- YouTube metadata
  title TEXT,
  description TEXT,
  tags_json TEXT, -- JSON array of tags
  youtube_video_id TEXT, -- After upload
  youtube_url TEXT,

  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_shorts_jobs_status ON shorts_jobs(status);

-- Orders for online ordering
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  stripe_session_id TEXT,
  stripe_payment_intent TEXT,
  customer_email TEXT,
  customer_name TEXT,
  items_json TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  total INTEGER NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
);

CREATE INDEX IF NOT EXISTS idx_orders_restaurant ON orders(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_orders_stripe_session ON orders(stripe_session_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- Reviews aggregated from external platforms
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  source TEXT NOT NULL, -- 'google', 'yelp'
  external_id TEXT, -- ID from source platform for deduplication
  author_name TEXT,
  author_url TEXT,
  rating REAL, -- 1-5 scale normalized
  text TEXT,
  review_date TEXT, -- ISO date from source
  sentiment_score REAL, -- -1.0 to 1.0
  sentiment_label TEXT, -- 'positive', 'negative', 'neutral', 'mixed'
  key_themes_json TEXT, -- JSON array of detected themes
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
  UNIQUE(restaurant_id, source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_reviews_restaurant ON reviews(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_reviews_source ON reviews(source);
CREATE INDEX IF NOT EXISTS idx_reviews_date ON reviews(review_date);
CREATE INDEX IF NOT EXISTS idx_reviews_sentiment ON reviews(sentiment_label);

-- Weekly digest summaries generated by AI
CREATE TABLE IF NOT EXISTS review_digests (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  period_start TEXT NOT NULL, -- ISO date
  period_end TEXT NOT NULL, -- ISO date
  review_count INTEGER DEFAULT 0,
  avg_rating REAL,
  summary TEXT, -- AI-generated sentiment summary
  complaints_json TEXT, -- JSON array of {theme, severity, examples}
  praise_json TEXT, -- JSON array of {theme, count, examples}
  actions_json TEXT, -- JSON array of {action, priority, reason}
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_digests_restaurant ON review_digests(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_digests_period ON review_digests(period_start, period_end);

-- Platform connections for fetching reviews
CREATE TABLE IF NOT EXISTS review_platform_tokens (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL UNIQUE,
  google_place_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_platform_tokens_restaurant ON review_platform_tokens(restaurant_id);

-- Digest preferences per restaurant
CREATE TABLE IF NOT EXISTS digest_preferences (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL UNIQUE,
  email_enabled INTEGER DEFAULT 0,
  email_address TEXT,
  frequency TEXT DEFAULT 'weekly', -- 'daily', 'weekly', 'monthly'
  day_of_week INTEGER DEFAULT 1, -- 0=Sun, 1=Mon, etc.
  hour_of_day INTEGER DEFAULT 9, -- 0-23
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_digest_prefs_restaurant ON digest_preferences(restaurant_id);

-- A/B Testing: Experiments
CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  change_type TEXT, -- 'cta', 'hero', 'layout', 'copy', 'color', 'menu'
  status TEXT DEFAULT 'pending', -- 'pending', 'running', 'paused', 'concluded', 'applied'
  winning_variant_id TEXT,
  pause_reason TEXT, -- Reason if paused (anomaly, manual, etc.)
  baseline_conversion_rate REAL, -- Historical rate before experiment
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_experiments_restaurant ON experiments(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_experiments_status ON experiments(status);

-- A/B Testing: Experiment Variants
CREATE TABLE IF NOT EXISTS experiment_variants (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  name TEXT NOT NULL, -- 'control', 'variant_a', 'variant_b'
  is_control INTEGER DEFAULT 0,
  change_prompt TEXT, -- AI prompt describing the change
  change_description TEXT, -- Human-readable description
  visitors INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  revenue REAL DEFAULT 0, -- Total revenue attributed to this variant
  traffic_allocation REAL DEFAULT 0.5, -- Traffic percentage (0-1)
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_variants_experiment ON experiment_variants(experiment_id);

-- A/B Testing: Experiment Queue (pre-generated hypotheses)
CREATE TABLE IF NOT EXISTS experiment_queue (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  change_type TEXT,
  variant_prompt TEXT,
  variant_description TEXT,
  priority INTEGER DEFAULT 0, -- Higher = run sooner
  source TEXT DEFAULT 'ai', -- 'ai', 'learning', 'manual'
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_queue_restaurant ON experiment_queue(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_queue_priority ON experiment_queue(priority DESC);

-- A/B Testing: Analytics Events
CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  variant_id TEXT,
  event_type TEXT NOT NULL, -- 'pageview', 'scroll', 'click', 'time_on_page', 'cart_add', 'order'
  event_data_json TEXT, -- JSON with event-specific data
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_analytics_restaurant ON analytics_events(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_analytics_session ON analytics_events(session_id);
CREATE INDEX IF NOT EXISTS idx_analytics_type ON analytics_events(event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics_events(created_at);

-- A/B Testing: Optimizer State per Restaurant
CREATE TABLE IF NOT EXISTS optimizer_state (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL UNIQUE,
  enabled INTEGER DEFAULT 0,
  experiments_this_week INTEGER DEFAULT 0,
  week_start TEXT, -- ISO date of current week start
  learnings_json TEXT, -- JSON array of past learnings
  compound_changes_json TEXT, -- JSON array of applied winning changes
  baseline_metrics_json TEXT, -- JSON with historical conversion/revenue baselines
  total_experiments INTEGER DEFAULT 0, -- Lifetime experiment count
  total_revenue_lift REAL DEFAULT 0, -- Cumulative revenue improvement
  last_optimization_at TEXT,
  last_digest_at TEXT, -- Last weekly performance digest
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_optimizer_restaurant ON optimizer_state(restaurant_id);
