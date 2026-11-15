/**
 * Side-effect module: import it FIRST in any script that touches the database.
 * ES imports are evaluated in order, so this runs before src/lib/db.ts and
 * src/lib/env.ts read the environment. See src/lib/dburl.ts for the rules.
 */
import path from "node:path";
import { applyDatabaseDefaults } from "../src/lib/dburl";

applyDatabaseDefaults(path.join(import.meta.dir, ".."));
