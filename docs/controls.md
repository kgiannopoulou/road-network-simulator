# Controls

| Input | Action |
| --- | --- |
| `W A S D` / arrows | Move camera |
| Mouse wheel | Zoom at cursor |
| Middle drag, or `Space` + drag | Pan |
| `F` / `0` | Fit network / reset view |
| `1` / `2` / `3` / `4` / `5` | Graph / Roads / Drive / Train / Navigate mode |

**Graph mode**

| Input | Action |
| --- | --- |
| Click empty space | Add a node (connected to the selected node) |
| Click a road | Split it with a new node (`Shift` to place a free node instead) |
| Click / drag a node | Select it, connect the selection to it, or move it |
| Right click | Deselect, or delete the hovered node or edge |
| `Del` / `Esc` | Delete the selected node / deselect |

**Roads mode**

| Input | Action |
| --- | --- |
| Click a road | Select it: lanes, direction, type, speed limit, crossing |
| Click a junction node | Choose its control: lights, all-way stop, stop/yield signs, priority to the right |
| `+` / `−` | Add / remove a lane |
| `O` | Toggle one-way |
| `R` | Reverse direction |

**Drive mode**

| Input | Action |
| --- | --- |
| `↑` / `W` | Throttle (brakes while reversing) |
| `↓` / `S` | Brake, then reverse once stopped |
| `←` `→` / `A` `D` | Steer |
| `Space` | Handbrake |
| `R` | Reset the car |
| `K` | Autopilot: the champion (or a random brain) drives |
| Mouse wheel | Zoom (the camera follows the car) |

**Simulation** (any mode)

| Input | Action |
| --- | --- |
| `T` | Traffic on / off |
| `[` / `]` | Fewer / more vehicles (in Train mode: slower / faster) |
| `M` | Physics model: basic (week 5) / bicycle (week 6) |
| `Y` | Road surface: dry / wet / icy |
| `C` | Collision debug view |
| `L` | Lanes view: lane IDs, centrelines, connections |
| `X` | Traffic routes view |
| `N` | Ghost mode (player ignores collisions) |
| `P` | Pause (in Train mode: pause training) |
| `Z` | Train mode: rendering on / off |
| `I` | Sensor panel + sensor views on the map |
| `U` | Sensor imperfections: perfect / realistic / degraded |

**Debug:** `F3` stats overlay · `B` geometry view · `V` graph skeleton · `G` grid snap · `Shift+G` grid · `H` help
