// A push-optimal Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
//
// The generator builds each level as a one-square hallway with one to four
// rooms off it, each room a small level of its own: a box pushed out of a
// room's door into the hallway can never come back, so every box stays in
// its room and the level's push-optimum is the sum of its rooms' optima.
// This solver therefore solves each room on its own, push-optimally, from
// its door, and stitches the rooms together with the player's walks.
//
// Per room it runs an A* over pushes (a state is the boxes plus the player's
// square; a step is one push, with the player's walk to the pushing square
// filled in), guided by a minimum-matching estimate of the pushes still
// needed, and prunes positions no push can save (corners, closed wall runs,
// 2x2 blocks, frozen boxes). Work is budgeted by counted expansions, never
// by the clock, so two runs write the same bytes.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Work budgets, counted in search expansions: never the clock, so runs agree. */
const ASTAR_BUDGET = 200_000;
const GREEDY_BUDGET = 100_000;
const INSTANCE_BUDGET = 500_000;

const DIRS = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
] as const;

interface Grid {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  goalSet: Uint8Array;
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Grid {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goalSet = new Uint8Array(w * h);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      if (ch !== '#') wall[i] = 0;
      if ('.*+'.includes(ch)) {
        goalSet[i] = 1;
        goals.push(i);
      }
      if ('$*'.includes(ch)) boxes.push(i);
      if ('@+'.includes(ch)) player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, goalSet, boxes, player };
}

/** Flood fill from `from` over cells that are not blocked. Returns the
 *  reached set plus, for every reached cell, the cell stepped from and the
 *  direction taken, so a walk to any reached cell can be read back. */
function flood(
  w: number,
  blocked: Uint8Array,
  from: number,
): { seen: Uint8Array; parent: Int32Array; pdir: Int8Array } {
  const seen = new Uint8Array(blocked.length);
  const parent = new Int32Array(blocked.length).fill(-1);
  const pdir = new Int8Array(blocked.length).fill(-1);
  const queue: number[] = [from];
  seen[from] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi]!;
    const cx = c % w;
    const cy = (c / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = cx + DIRS[d]!.dx;
      const ny = cy + DIRS[d]!.dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= (blocked.length / w)) continue;
      const q = ny * w + nx;
      if (blocked[q] || seen[q]) continue;
      seen[q] = 1;
      parent[q] = c;
      pdir[q] = d;
      queue.push(q);
    }
  }
  return { seen, parent, pdir };
}

/** The walk from `from` to `to` as a move string, or null when unreachable.
 *  `blocked` marks walls and boxes; the walk itself moves no box. */
function walkMoves(
  w: number,
  blocked: Uint8Array,
  from: number,
  to: number,
): string | null {
  if (from === to) return '';
  const { seen, parent, pdir } = flood(w, blocked, from);
  if (!seen[to]) return null;
  const letters: string[] = [];
  let c = to;
  while (c !== from) {
    letters.push(DIRS[pdir[c]!]!.ch);
    c = parent[c]!;
  }
  letters.reverse();
  return letters.join('');
}

/** Breadth-first distances from `from` over cells that are not walls. */
function bfsDist(w: number, wall: Uint8Array, from: number): Float64Array {
  const dist = new Float64Array(wall.length).fill(Infinity);
  const queue: number[] = [from];
  dist[from] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi]!;
    const cx = c % w;
    const cy = (c / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = cx + DIRS[d]!.dx;
      const ny = cy + DIRS[d]!.dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= (wall.length / w)) continue;
      const q = ny * w + nx;
      if (wall[q] || dist[q] !== Infinity) continue;
      dist[q] = dist[c]! + 1;
      queue.push(q);
    }
  }
  return dist;
}

/** A minimal binary heap ordered by (f, h, insertion order). */
class Heap {
  private a: [number, number, number, number][] = [];
  get size(): number {
    return this.a.length;
  }
  private less(x: [number, number, number, number], y: [number, number, number, number]): boolean {
    return (
      x[0] < y[0] ||
      (x[0] === y[0] && (x[1] < y[1] || (x[1] === y[1] && x[2] < y[2])))
    );
  }
  push(e: [number, number, number, number]): void {
    let i = this.a.length;
    this.a.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(this.a[i]!, this.a[p]!)) break;
      [this.a[i], this.a[p]] = [this.a[p]!, this.a[i]!];
      i = p;
    }
  }
  pop(): [number, number, number, number] {
    const top = this.a[0]!;
    const last = this.a.pop()!;
    if (this.a.length > 0) {
      this.a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.a.length && this.less(this.a[l]!, this.a[m]!)) m = l;
        if (r < this.a.length && this.less(this.a[r]!, this.a[m]!)) m = r;
        if (m === i) break;
        [this.a[i], this.a[m]] = [this.a[m]!, this.a[i]!];
        i = m;
      }
    }
    return top;
  }
}

interface RoomSearch {
  /** Cells the player may walk on: the room's cells plus the hallway square
   *  outside its door. Boxes may only ever be pushed onto room cells. */
  walkable: Uint8Array;
  roomCells: Uint8Array;
  goals: number[];
  goalSet: Uint8Array;
  /** For each goal, grid distances over walkable cells (boxes ignored). */
  distToGoal: Float64Array[];
  /** Cells a box can never leave towards a goal: closed wall runs with no goal. */
  deadWall: Uint8Array;
}

/** Build the per-room search tables from the grid and the room's cells. */
function makeRoomSearch(g: Grid, roomCells: Uint8Array, outside: number): RoomSearch {
  const walkable = new Uint8Array(g.w * g.h);
  const goals: number[] = [];
  for (let i = 0; i < roomCells.length; i++) {
    if (roomCells[i]) {
      walkable[i] = 1;
      if (g.goalSet[i]) goals.push(i);
    }
  }
  walkable[outside] = 1;
  const roomWall = new Uint8Array(g.w * g.h);
  for (let i = 0; i < roomWall.length; i++) roomWall[i] = walkable[i] ? 0 : 1;
  const distToGoal = goals.map((goal) => bfsDist(g.w, roomWall, goal));
  // A wall run is a maximal run of floor cells against one wall side; a box
  // on a run with no goal, closed at both ends by walls (or the board's
  // edge), can never reach a goal: it cannot be pushed off the wall, and it
  // cannot slide past a closed end.
  const deadWall = new Uint8Array(g.w * g.h);
  const wallAt = (x: number, y: number): boolean =>
    x < 0 || y < 0 || x >= g.w || y >= g.h || g.wall[y * g.w + x] === 1;
  const markRun = (cells: number[]): void => {
    if (cells.length === 0) return;
    if (cells.some((c) => g.goalSet[c])) return;
    for (const c of cells) deadWall[c] = 1;
  };
  // Horizontal runs: cells with a wall above, and cells with a wall below.
  for (const above of [true, false]) {
    for (let y = 0; y < g.h; y++) {
      let x = 0;
      while (x < g.w) {
        if (g.wall[y * g.w + x] || !wallAt(x, above ? y - 1 : y + 1)) {
          x++;
          continue;
        }
        const run: number[] = [];
        const start = x;
        while (
          x < g.w &&
          !g.wall[y * g.w + x] &&
          wallAt(x, above ? y - 1 : y + 1)
        ) {
          run.push(y * g.w + x);
          x++;
        }
        const leftClosed = start === 0 || wallAt(start - 1, y);
        const rightClosed = x === g.w || wallAt(x, y);
        if (leftClosed && rightClosed) markRun(run);
      }
    }
  }
  // Vertical runs: cells with a wall to the left, and to the right.
  for (const left of [true, false]) {
    for (let x = 0; x < g.w; x++) {
      let y = 0;
      while (y < g.h) {
        if (g.wall[y * g.w + x] || !wallAt(left ? x - 1 : x + 1, y)) {
          y++;
          continue;
        }
        const run: number[] = [];
        const start = y;
        while (
          y < g.h &&
          !g.wall[y * g.w + x] &&
          wallAt(left ? x - 1 : x + 1, y)
        ) {
          run.push(y * g.w + x);
          y++;
        }
        const topClosed = start === 0 || wallAt(x, start - 1);
        const bottomClosed = y === g.h || wallAt(x, y);
        if (topClosed && bottomClosed) markRun(run);
      }
    }
  }
  return { walkable, roomCells, goals, goalSet: g.goalSet, distToGoal, deadWall };
}

/** True when no push can ever save this box placement. */
function isDead(
  g: Grid,
  rs: RoomSearch,
  boxes: number[],
  boxSet: Uint8Array,
): boolean {
  const n = boxes.length;
  for (let bi = 0; bi < n; bi++) {
    const b = boxes[bi]!;
    if (g.goalSet[b]) continue;
    const bx = b % g.w;
    const by = (b / g.w) | 0;
    const wallAt = (x: number, y: number): boolean =>
      x < 0 || y < 0 || x >= g.w || y >= g.h || g.wall[y * g.w + x] === 1;
    // A corner (two perpendicular walls) with no goal is a grave.
    if (
      (wallAt(bx, by - 1) && wallAt(bx - 1, by)) ||
      (wallAt(bx, by - 1) && wallAt(bx + 1, by)) ||
      (wallAt(bx, by + 1) && wallAt(bx - 1, by)) ||
      (wallAt(bx, by + 1) && wallAt(bx + 1, by))
    ) {
      return true;
    }
    // A closed wall run with no goal is a grave.
    if (rs.deadWall[b]) return true;
    // A 2x2 block of walls and boxes holds every box in it still: each push
    // of a box in the block needs the player, or the destination, inside the
    // block, and both are taken. One box off its goal there is a grave.
    for (let dy = -1; dy <= 0; dy++) {
      for (let dx = -1; dx <= 0; dx++) {
        const x0 = bx + dx;
        const y0 = by + dy;
        if (x0 < 0 || y0 < 0 || x0 + 1 >= g.w || y0 + 1 >= g.h) continue;
        let full = true;
        let offGoal = false;
        for (let yy = 0; yy < 2; yy++) {
          for (let xx = 0; xx < 2; xx++) {
            const c = (y0 + yy) * g.w + (x0 + xx);
            if (g.wall[c]) continue;
            if (boxSet[c]) {
              if (!g.goalSet[c]) offGoal = true;
              continue;
            }
            full = false;
          }
        }
        if (full && offGoal) return true;
      }
    }
  }
  // Frozen boxes: a box that cannot be pushed in any direction, where the
  // boxes blocking it are themselves frozen, never moves again.
  const frozen = new Uint8Array(g.w * g.h);
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of boxes) {
      if (frozen[b] || g.goalSet[b]) continue;
      const bx = b % g.w;
      const by = (b / g.w) | 0;
      let canMove = false;
      for (let d = 0; d < 4; d++) {
        const px = bx - DIRS[d]!.dx;
        const py = by - DIRS[d]!.dy;
        const tx = bx + DIRS[d]!.dx;
        const ty = by + DIRS[d]!.dy;
        const pBlocked =
          px < 0 || py < 0 || px >= g.w || py >= g.h ||
          g.wall[py * g.w + px] === 1 || frozen[py * g.w + px] === 1;
        const tBlocked =
          tx < 0 || ty < 0 || tx >= g.w || ty >= g.h ||
          g.wall[ty * g.w + tx] === 1 || frozen[ty * g.w + tx] === 1;
        if (!pBlocked && !tBlocked) {
          canMove = true;
          break;
        }
      }
      if (!canMove) {
        frozen[b] = 1;
        changed = true;
      }
    }
  }
  for (const b of boxes) {
    if (frozen[b] && !g.goalSet[b]) return true;
  }
  return false;
}

/** Minimum-matching lower bound on the pushes still needed: each push moves
 *  one box one square, so the cheapest assignment of boxes to goals, at
 *  grid distance, never overestimates. Infinity when a box cannot reach
 *  any goal at all. */
function heuristic(rs: RoomSearch, boxes: number[]): number {
  const n = boxes.length;
  if (n === 0) return 0;
  if (n !== rs.goals.length) return Infinity;
  // Cost of box i to goal j.
  const cost: number[][] = boxes.map((b) =>
    rs.goals.map((_, j) => rs.distToGoal[j]![b]!),
  );
  // Brute-force assignment (n <= 4, so at most 24 orders).
  const perm = rs.goals.map((_, j) => j);
  let best = Infinity;
  const walk = (k: number, used: number, sum: number): void => {
    if (sum >= best) return;
    if (k === n) {
      best = sum;
      return;
    }
    for (let j = 0; j < n; j++) {
      if (used & (1 << j)) continue;
      const c = cost[k]![j]!;
      if (c === Infinity) continue;
      walk(k + 1, used | (1 << j), sum + c);
    }
  };
  walk(0, 0, 0);
  return best;
}

interface SearchResult {
  moves: string;
  pushes: number;
}

/** Push-optimal A* (or greedy best-first when `greedy`) over one room.
 *  A state is the boxes plus the player's square; the player only matters
 *  through the region it can reach, so the visited key uses the smallest
 *  square of that region. `budget` counts expansions across the whole run. */
function searchRoom(
  g: Grid,
  rs: RoomSearch,
  boxes0: number[],
  startPlayer: number,
  greedy: boolean,
  budget: { used: number; limit: number },
): SearchResult | null {
  const n = boxes0.length;
  const goalKey = (bs: number[]): boolean => bs.every((b) => g.goalSet[b]);
  if (goalKey(boxes0)) return { moves: '', pushes: 0 };
  if (heuristic(rs, boxes0) === Infinity) return null;

  const heap = new Heap();
  const nodesBoxes: number[][] = [];
  const nodesPlayer: number[] = [];
  const nodesParent: number[] = [];
  const nodesMoves: string[] = [];
  const nodesG: number[] = [];
  const visited = new Map<string, number>();
  let counter = 0;

  const boxSetOf = (bs: number[]): Uint8Array => {
    const s = new Uint8Array(g.w * g.h);
    for (const b of bs) s[b] = 1;
    return s;
  };
  const canonOf = (bs: number[], player: number): number => {
    const blocked = new Uint8Array(g.w * g.h);
    for (let i = 0; i < blocked.length; i++) blocked[i] = g.wall[i] || !rs.walkable[i] ? 1 : 0;
    for (const b of bs) blocked[b] = 1;
    const { seen } = flood(g.w, blocked, player);
    let min = Infinity;
    for (let i = 0; i < seen.length; i++) if (seen[i]) min = Math.min(min, i);
    return min;
  };
  const keyOf = (bs: number[], canon: number): string => bs.join(',') + '|' + canon;

  const h0 = heuristic(rs, boxes0);
  nodesBoxes.push([...boxes0]);
  nodesPlayer.push(startPlayer);
  nodesParent.push(-1);
  nodesMoves.push('');
  nodesG.push(0);
  visited.set(keyOf(boxes0, canonOf(boxes0, startPlayer)), 0);
  heap.push([greedy ? h0 : h0, h0, counter++, 0]);

  while (heap.size > 0) {
    if (budget.used >= budget.limit) return null;
    const [, , , ni] = heap.pop();
    const boxes = nodesBoxes[ni]!;
    const player = nodesPlayer[ni]!;
    const gg = nodesG[ni]!;
    budget.used++;
    if (goalKey(boxes)) {
      // Rebuild the move string from the parents.
      const parts: string[] = [];
      let cur = ni;
      while (cur > 0) {
        parts.push(nodesMoves[cur]!);
        cur = nodesParent[cur]!;
      }
      parts.reverse();
      return { moves: parts.join(''), pushes: gg };
    }
    // The player's walkable region and the walks it allows.
    const blocked = new Uint8Array(g.w * g.h);
    for (let i = 0; i < blocked.length; i++) blocked[i] = g.wall[i] || !rs.walkable[i] ? 1 : 0;
    const boxSet = boxSetOf(boxes);
    for (const b of boxes) blocked[b] = 1;
    const { seen, parent, pdir } = flood(g.w, blocked, player);
    const walkTo = (to: number): string => {
      const letters: string[] = [];
      let c = to;
      while (c !== player) {
        letters.push(DIRS[pdir[c]!]!.ch);
        c = parent[c]!;
      }
      letters.reverse();
      return letters.join('');
    };
    for (let bi = 0; bi < n; bi++) {
      const b = boxes[bi]!;
      const bx = b % g.w;
      const by = (b / g.w) | 0;
      for (let d = 0; d < 4; d++) {
        const px = bx - DIRS[d]!.dx;
        const py = by - DIRS[d]!.dy;
        const tx = bx + DIRS[d]!.dx;
        const ty = by + DIRS[d]!.dy;
        if (px < 0 || py < 0 || px >= g.w || py >= g.h) continue;
        if (tx < 0 || ty < 0 || tx >= g.w || ty >= g.h) continue;
        const pushPos = py * g.w + px;
        const dest = ty * g.w + tx;
        if (!rs.roomCells[dest]) continue;
        if (boxSet[dest]) continue;
        if (!seen[pushPos]) continue;
        const next = [...boxes];
        next[bi] = dest;
        next.sort((a, b2) => a - b2);
        const nextSet = boxSetOf(next);
        if (isDead(g, rs, next, nextSet)) continue;
        const h = heuristic(rs, next);
        if (h === Infinity) continue;
        const canon = canonOf(next, b);
        const key = keyOf(next, canon);
        const prev = visited.get(key);
        if (prev !== undefined && prev <= gg + 1) continue;
        visited.set(key, gg + 1);
        const id = nodesBoxes.length;
        nodesBoxes.push(next);
        nodesPlayer.push(b);
        nodesParent.push(ni);
        nodesMoves.push(walkTo(pushPos) + DIRS[d]!.ch);
        nodesG.push(gg + 1);
        heap.push([greedy ? h : gg + 1 + h, h, counter++, id]);
      }
    }
  }
  return null;
}

/** Find the rooms: the hallway row holds the player; each room opens onto
 *  it through one door, a non-wall square in the wall row beside it. */
function findRooms(g: Grid): { cells: Uint8Array; door: number; outside: number }[] {
  const hallRow = (g.player / g.w) | 0;
  const rooms: { cells: Uint8Array; door: number; outside: number }[] = [];
  const seenCells = new Set<string>();
  for (const side of [-1, 1]) {
    const doorRow = hallRow + side;
    if (doorRow < 0 || doorRow >= g.h) continue;
    for (let x = 0; x < g.w; x++) {
      const door = doorRow * g.w + x;
      if (g.wall[door]) continue;
      const outside = hallRow * g.w + x;
      // Flood the room from its door, never crossing the hallway row.
      const cells = new Uint8Array(g.w * g.h);
      const queue: number[] = [door];
      cells[door] = 1;
      for (let qi = 0; qi < queue.length; qi++) {
        const c = queue[qi]!;
        const cx = c % g.w;
        const cy = (c / g.w) | 0;
        for (let d = 0; d < 4; d++) {
          const nx = cx + DIRS[d]!.dx;
          const ny = cy + DIRS[d]!.dy;
          if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) continue;
          if (side < 0 ? ny >= hallRow : ny <= hallRow) continue;
          const q = ny * g.w + nx;
          if (g.wall[q] || cells[q]) continue;
          cells[q] = 1;
          queue.push(q);
        }
      }
      const sig = [...cells].join('');
      if (seenCells.has(sig)) continue;
      seenCells.add(sig);
      rooms.push({ cells, door, outside });
    }
  }
  // Top rooms first, then bottom, each left to right: a fixed order.
  rooms.sort((a, b) => (a.door < b.door ? -1 : a.door > b.door ? 1 : 0));
  return rooms;
}

function solveLevel(g: Grid, budget: { used: number; limit: number }): string {
  const rooms = findRooms(g);
  // Every box must belong to exactly one room, and each room's boxes must
  // match its goals; otherwise fall back to a whole-level search.
  const roomOf = new Int32Array(g.w * g.h).fill(-1);
  let decomposed = rooms.length > 0;
  rooms.forEach((r, ri) => {
    for (let i = 0; i < r.cells.length; i++) if (r.cells[i]) roomOf[i] = ri;
  });
  const roomBoxes: number[][] = rooms.map(() => []);
  const roomGoals: number[][] = rooms.map(() => []);
  for (const b of g.boxes) {
    const ri = roomOf[b];
    if (ri < 0) decomposed = false;
    else roomBoxes[ri]!.push(b);
  }
  for (const goal of g.goals) {
    const ri = roomOf[goal];
    if (ri < 0) decomposed = false;
    else roomGoals[ri]!.push(goal);
  }
  rooms.forEach((_, ri) => {
    if (roomBoxes[ri]!.length !== roomGoals[ri]!.length) decomposed = false;
  });
  if (!decomposed) {
    // Whole-level push search: the same room machinery over all floor.
    const all = new Uint8Array(g.w * g.h);
    for (let i = 0; i < all.length; i++) all[i] = g.wall[i] ? 0 : 1;
    const rs = makeRoomSearch(g, all, g.player);
    const r =
      searchRoom(g, rs, [...g.boxes], g.player, false, budget) ??
      searchRoom(g, rs, [...g.boxes], g.player, true, budget);
    return r ? r.moves : '';
  }

  let moves = '';
  let player = g.player;
  // The boxes as they stand now, for the walks between rooms.
  const liveBoxes = new Set<number>(g.boxes);
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri]!;
    const boxes = roomBoxes[ri]!;
    if (boxes.length === 0) continue;
    // Walk to the hallway square outside this room's door.
    const blocked = new Uint8Array(g.w * g.h);
    for (let i = 0; i < blocked.length; i++) blocked[i] = g.wall[i] ? 1 : 0;
    for (const b of liveBoxes) blocked[b] = 1;
    const walk = walkMoves(g.w, blocked, player, room.outside);
    if (walk === null) return '';
    moves += walk;
    player = room.outside;
    // Solve the room from its door, push-optimally, then greedily.
    const rs = makeRoomSearch(g, room.cells, room.outside);
    const solved =
      searchRoom(g, rs, [...boxes], room.outside, false, budget) ??
      searchRoom(g, rs, [...boxes], room.outside, true, budget);
    if (!solved) return '';
    moves += solved.moves;
    // The room's boxes now sit on its goals; the player ends where the
    // solution leaves them. Recompute both from the solution's effect by
    // replaying the moves on a copy of the level state.
    const replay = replayMoves(g, player, boxes, solved.moves);
    if (!replay) return '';
    for (const b of boxes) liveBoxes.delete(b);
    for (const b of replay.boxes) liveBoxes.add(b);
    player = replay.player;
  }
  return moves;
}

/** Replay a move string on the level restricted to `boxes` (the other
 *  rooms' boxes are walls for this replay): returns the end state, or null
 *  on an illegal step. Used to learn where a room's solution leaves the
 *  player and its boxes. */
function replayMoves(
  g: Grid,
  player0: number,
  boxes0: number[],
  moves: string,
): { player: number; boxes: number[] } | null {
  let player = player0;
  const boxes = [...boxes0];
  const boxAt = new Map<number, number>();
  boxes.forEach((b, i) => boxAt.set(b, i));
  for (const ch of moves) {
    const d = DIRS.find((dd) => dd.ch === ch);
    if (!d) return null;
    const px = player % g.w;
    const py = (player / g.w) | 0;
    const nx = px + d.dx;
    const ny = py + d.dy;
    if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) return null;
    const next = ny * g.w + nx;
    if (g.wall[next]) return null;
    const bi = boxAt.get(next);
    if (bi !== undefined) {
      const tx = nx + d.dx;
      const ty = ny + d.dy;
      if (tx < 0 || ty < 0 || tx >= g.w || ty >= g.h) return null;
      const dest = ty * g.w + tx;
      if (g.wall[dest] || boxAt.has(dest)) return null;
      boxAt.delete(next);
      boxAt.set(dest, bi);
      boxes[bi] = dest;
    }
    player = next;
  }
  return { player, boxes };
}

for (const id of readdirSync(I).sort()) {
  const budget = { used: 0, limit: INSTANCE_BUDGET };
  let moves = '';
  try {
    const level = parseLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
    moves = solveLevel(level, budget);
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
