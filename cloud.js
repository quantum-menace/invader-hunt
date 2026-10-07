'use strict';

// Everything that talks to Supabase. When config.js has no project set,
// Cloud.enabled is false and the app runs on this device only.
const Cloud = (() => {
  const cfg = window.INVADER_CONFIG || {};
  const enabled = !!(cfg.supabaseUrl && cfg.supabaseKey && window.supabase);
  const sb = enabled ? supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey) : null;
  const BUCKET = 'refs';

  async function run(promise) {
    const { data, error } = await promise;
    if (error) throw new Error(error.message);
    return data;
  }

  function refUrl(r) {
    return r.url || sb.storage.from(BUCKET).getPublicUrl(r.storage_path).data.publicUrl;
  }

  function playerId(name) {
    return name.trim().toLowerCase();
  }

  return {
    enabled,

    // ---------- invaders ----------
    async loadInvaders() {
      const [invaders, refs] = await Promise.all([
        run(sb.from('invaders').select('*').order('id')),
        run(sb.from('refs').select('*').order('id')),
      ]);
      return invaders.map((inv) => ({
        id: inv.id, name: inv.name, city: inv.city, lat: inv.lat, lng: inv.lng, points: inv.points,
        refs: refs.filter((r) => r.invader_id === inv.id).map(refUrl),
      }));
    },

    // ---------- players ----------
    async join(name) {
      const display = name.trim().replace(/\s+/g, ' ');
      if (display.length < 2 || display.length > 20) throw new Error('Names need 2 to 20 characters.');
      const id = playerId(display);
      await run(sb.from('players').upsert({ id, display_name: display }, { onConflict: 'id', ignoreDuplicates: true }));
      const row = await run(sb.from('players').select('id, display_name').eq('id', id).single());
      return row;
    },

    async loadFinds(pid) {
      const rows = await run(sb.from('finds').select('*').eq('player_id', pid));
      const out = {};
      for (const r of rows) {
        out[r.invader_id] = {
          at: Date.parse(r.found_at), score: r.score, thumb: r.thumb,
          lat: r.lat, lng: r.lng, simulated: r.simulated, synced: true,
        };
      }
      return out;
    },

    async saveFind(pid, invaderId, f) {
      await run(sb.from('finds').upsert({
        player_id: pid, invader_id: invaderId, found_at: new Date(f.at).toISOString(),
        score: f.score, lat: f.lat, lng: f.lng, simulated: !!f.simulated, thumb: f.thumb,
      }, { onConflict: 'player_id,invader_id' }));
    },

    async deleteFinds(pid) {
      await run(sb.from('finds').delete().eq('player_id', pid));
    },

    async leaderboard() {
      return run(sb.from('leaderboard').select('*')
        .order('points', { ascending: false }).order('found', { ascending: false }).limit(50));
    },

    // ---------- admins ----------
    async adminSession() {
      const { data } = await sb.auth.getSession();
      return data.session;
    },
    async adminSignIn(email, password) {
      await run(sb.auth.signInWithPassword({ email, password }));
      if (!(await run(sb.rpc('is_admin')))) {
        await sb.auth.signOut();
        throw new Error('This account is not an admin. Add its email to the admins table first.');
      }
    },
    async isAdmin() {
      return !!(await run(sb.rpc('is_admin')));
    },
    async adminSignOut() {
      await sb.auth.signOut();
    },

    async createInvader(inv) {
      await run(sb.from('invaders').insert(inv));
    },
    async moveInvader(id, lat, lng) {
      await run(sb.from('invaders').update({ lat, lng }).eq('id', id));
    },

    // Uploads a reference photo and returns its public URL.
    async uploadRef(invaderId, blob) {
      const path = `${invaderId}/${Date.now()}.jpg`;
      await run(sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg' }));
      await run(sb.from('refs').insert({ invader_id: invaderId, storage_path: path }));
      return refUrl({ storage_path: path });
    },
  };
})();
