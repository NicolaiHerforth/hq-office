// Which floor this copy of the room modules belongs to. The page's own graph is HQ's floor; a floor's copy is loaded
// from /floor/<id>/src/client/... and the browser gives it its own instance of every module.
import { floorFromPath } from "../core/floors.js";

export const FLOOR = floorFromPath(import.meta.url);
