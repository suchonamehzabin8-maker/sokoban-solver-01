[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/suchonamehzabin8-maker/sokoban-solver-01/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/suchonamehzabin8-maker/sokoban-solver-01/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

# Sokoban Solver — push-optimal, room by room

An entry for make.fun's `sokoban-solver-01-run-20261121` competition:
a Node 22 program (`main.ts`, standard library only) that answers every
instance of a set in one run, writing `/output/<id>/solution.txt` for each.

## How it works

Each level is a one-square hallway with one to four rooms off it, and a box
pushed out of a room's door into the hallway can never come back — so every
box stays in its room and the level's push-optimum is the sum of its rooms'
optima. The solver finds the rooms from the hallway, then solves each room
on its own, push-optimally, from its door, and stitches the rooms together
with the player's walks.

Per room it runs an A* over pushes (a state is the boxes plus the player's
square; a step is one push, with the player's walk to the pushing square
filled in), guided by a minimum-matching estimate of the pushes still
needed, and it prunes positions no push can save: corners, closed wall
runs, 2x2 blocks and frozen boxes. Work is budgeted by counted expansions,
never by the clock, so two runs write the same bytes.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=<input-dir> MAKEFUN_OUTPUT_DIR=out node main.ts
```

On the kit's practice set it scores 1,000 on every instance (push-optimal
on all five levels: 13, 16, 29, 47 and 60 pushes).
