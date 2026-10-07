// Supabase connection. Both values are meant to be public: the database's
// access rules (supabase/schema.sql) decide what this key may do.
// Leave them empty to run the app without accounts or a leaderboard.
window.INVADER_CONFIG = {
  supabaseUrl: '',   // Project Settings › API › Project URL, e.g. https://abcd1234.supabase.co
  supabaseKey: '',   // Project Settings › API Keys › publishable key (or the legacy "anon" key)
};
