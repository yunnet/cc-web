const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { dataDir } = require('./data-dir');

// Space persistence: a single spaces.json in the data dir.
//
// A space is the sidebar's named working-directory group: { id, name, dir }.
// Sessions point back at one by id (session.spaceId, persisted with the
// session in its own file under sessions/). The list is tiny — a handful of
// working directories — so unlike sessions (where two instances sharing a
// data dir once erased each other via whole-file rewrites, hence one file per
// session), a single atomically-replaced file is the honest shape. Instances
// get separate data dirs anyway (CCW_DATA_DIR / data-<port>, see
// ts/ccweb.sh), so there is no second writer to race.
//
// Corrupt JSON degrades to an empty list rather than throwing: the sidebar
// shows every session under 未分组 and the one-time migration (server.js
// loadSpacesAndMigrate) rebuilds the file from the sessions' working dirs.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same length cap as a session name (PATCH /api/sessions/:id).
const MAX_NAME = 200;

class SpaceStore {
    constructor() {
        // See SessionStore for why this is dataDir() and derived-per-access
        // matters (a test redirecting storageDir after construction).
        this.storageDir = dataDir();
        // Whether the last load read a WELL-FORMED file. ENOENT and corrupt
        // JSON both leave it false, which is what lets the one-time migration
        // rebuild a spaces.json that was never written or got destroyed.
        this.fileExisted = false;
    }

    get spacesFile() {
        return path.join(this.storageDir, 'spaces.json');
    }

    // One entry of the list. Returns null for anything malformed; loadSpaces
    // counts and logs what it dropped instead of failing the whole list.
    static sanitize(space) {
        if (!space || typeof space !== 'object' || !UUID.test(String(space.id))) return null;
        const name = typeof space.name === 'string' ? space.name.trim() : '';
        if (!name || name.length > MAX_NAME) return null;
        if (typeof space.dir !== 'string' || !space.dir.trim()) return null;
        return {
            id: space.id,
            name,
            dir: space.dir,
            createdAt: space.createdAt || new Date().toISOString(),
            updatedAt: space.updatedAt || space.createdAt || new Date().toISOString(),
        };
    }

    async loadSpaces() {
        let raw;
        try {
            raw = await fs.readFile(this.spacesFile, 'utf8');
        } catch (error) {
            this.fileExisted = false;
            if (error.code !== 'ENOENT') {
                console.error('Failed to read spaces.json:', error.message);
            }
            return [];
        }
        try {
            const parsed = JSON.parse(raw);
            const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.spaces) ? parsed.spaces : []);
            const spaces = list.map(SpaceStore.sanitize).filter(Boolean);
            if (spaces.length !== list.length) {
                console.error(`spaces.json: skipped ${list.length - spaces.length} malformed entr${list.length - spaces.length === 1 ? 'y' : 'ies'}`);
            }
            this.fileExisted = true;
            return spaces;
        } catch (error) {
            console.error('spaces.json is corrupted, starting from an empty list:', error.message);
            this.fileExisted = false;
            return [];
        }
    }

    // Shared by POST and PATCH /api/spaces: trim + length check, returning
    // either the cleaned name or the error the route answers with.
    static cleanName(raw) {
        if (typeof raw !== 'string') return { error: 'name must be a string' };
        const name = raw.trim();
        if (!name) return { error: 'name must not be empty' };
        if (name.length > MAX_NAME) return { error: `name must be at most ${MAX_NAME} characters` };
        return { name };
    }

    // Whole-list atomic write (temp + rename), the same shape as
    // SessionStore.writeOne: unique temp name per write so overlapping saves
    // cannot share one temp file, rename makes the swap atomic for readers.
    async saveSpaces(spaces) {
        const target = this.spacesFile;
        const tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
        try {
            await fs.mkdir(this.storageDir, { recursive: true, mode: 0o700 });
            await fs.writeFile(tmp, JSON.stringify(spaces, null, 2));
            await fs.rename(tmp, target);
            return true;
        } catch (error) {
            try { await fs.unlink(tmp); } catch (_) { /* nothing to clean up */ }
            console.error('Failed to save spaces:', error.message);
            return false;
        }
    }
}

module.exports = SpaceStore;
module.exports.MAX_NAME = MAX_NAME;
