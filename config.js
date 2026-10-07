// Supabase connection. Both values are meant to be public: the database's
// access rules (supabase/schema.sql) decide what this key may do.
// Leave them empty to run the app without accounts or a leaderboard.
window.INVADER_CONFIG = {
  supabaseUrl: 'https://shpjtjsjinejatcklijv.supabase.co',   // Project Settings › API › Project URL, e.g. https://abcd1234.supabase.co
  supabaseKey: 'sb_publishable_0letNKqHoIz2gjPyBrkDpg_PSLR3qa-',   // Project Settings › API Keys › publishable key (or the legacy "anon" key)
  // Logging in with the name "admin" signs in to this Supabase user behind the
  // scenes. Create it under Authentication › Users; it never receives email.
  adminEmail: 'admin@invader-hunt.local',
};
