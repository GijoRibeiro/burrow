#!/bin/bash
RENDER="/Users/gijo/.claude/skills/pixel-art-gen/scripts/render_pixel_art.py"
OUT="/Users/gijo/Documents/Code/bitwise/web/assets/sprites"
C="#eae5ce"

# Beholder - Frame 1 (15x15, center at 7,7)
cat > /tmp/cr-beholder-1.json << EOF
{
  "width":15,"height":15,"background":"transparent","pixel_size":1,"grid_lines":false,
  "pixels":[
    {"x":4,"y":0,"color":"$C"},{"x":5,"y":0,"color":"$C"},{"x":9,"y":0,"color":"$C"},{"x":10,"y":0,"color":"$C"},
    {"x":4,"y":1,"color":"$C"},{"x":5,"y":1,"color":"$C"},{"x":9,"y":1,"color":"$C"},{"x":10,"y":1,"color":"$C"},
    {"x":4,"y":2,"color":"$C"},{"x":5,"y":2,"color":"$C"},{"x":6,"y":2,"color":"$C"},{"x":7,"y":2,"color":"$C"},{"x":8,"y":2,"color":"$C"},{"x":9,"y":2,"color":"$C"},{"x":10,"y":2,"color":"$C"},
    {"x":3,"y":3,"color":"$C"},{"x":4,"y":3,"color":"$C"},{"x":10,"y":3,"color":"$C"},{"x":11,"y":3,"color":"$C"},
    {"x":2,"y":4,"color":"$C"},{"x":3,"y":4,"color":"$C"},{"x":11,"y":4,"color":"$C"},{"x":12,"y":4,"color":"$C"},
    {"x":2,"y":5,"color":"$C"},{"x":5,"y":5,"color":"$C"},{"x":6,"y":5,"color":"$C"},{"x":7,"y":5,"color":"$C"},{"x":8,"y":5,"color":"$C"},{"x":9,"y":5,"color":"$C"},{"x":12,"y":5,"color":"$C"},
    {"x":2,"y":6,"color":"$C"},{"x":4,"y":6,"color":"$C"},{"x":7,"y":6,"color":"$C"},{"x":10,"y":6,"color":"$C"},{"x":12,"y":6,"color":"$C"},
    {"x":2,"y":7,"color":"$C"},{"x":4,"y":7,"color":"$C"},{"x":6,"y":7,"color":"$C"},{"x":7,"y":7,"color":"$C"},{"x":8,"y":7,"color":"$C"},{"x":10,"y":7,"color":"$C"},{"x":12,"y":7,"color":"$C"},
    {"x":2,"y":8,"color":"$C"},{"x":4,"y":8,"color":"$C"},{"x":7,"y":8,"color":"$C"},{"x":10,"y":8,"color":"$C"},{"x":12,"y":8,"color":"$C"},
    {"x":2,"y":9,"color":"$C"},{"x":5,"y":9,"color":"$C"},{"x":6,"y":9,"color":"$C"},{"x":7,"y":9,"color":"$C"},{"x":8,"y":9,"color":"$C"},{"x":9,"y":9,"color":"$C"},{"x":12,"y":9,"color":"$C"},
    {"x":2,"y":10,"color":"$C"},{"x":3,"y":10,"color":"$C"},{"x":11,"y":10,"color":"$C"},{"x":12,"y":10,"color":"$C"},
    {"x":3,"y":11,"color":"$C"},{"x":4,"y":11,"color":"$C"},{"x":10,"y":11,"color":"$C"},{"x":11,"y":11,"color":"$C"},
    {"x":4,"y":12,"color":"$C"},{"x":5,"y":12,"color":"$C"},{"x":6,"y":12,"color":"$C"},{"x":7,"y":12,"color":"$C"},{"x":8,"y":12,"color":"$C"},{"x":9,"y":12,"color":"$C"},{"x":10,"y":12,"color":"$C"}
  ]
}
EOF

# Beholder - Frame 2 (bob down 1px)
cat > /tmp/cr-beholder-2.json << EOF
{
  "width":15,"height":15,"background":"transparent","pixel_size":1,"grid_lines":false,
  "pixels":[
    {"x":4,"y":1,"color":"$C"},{"x":5,"y":1,"color":"$C"},{"x":9,"y":1,"color":"$C"},{"x":10,"y":1,"color":"$C"},
    {"x":4,"y":2,"color":"$C"},{"x":5,"y":2,"color":"$C"},{"x":9,"y":2,"color":"$C"},{"x":10,"y":2,"color":"$C"},
    {"x":4,"y":3,"color":"$C"},{"x":5,"y":3,"color":"$C"},{"x":6,"y":3,"color":"$C"},{"x":7,"y":3,"color":"$C"},{"x":8,"y":3,"color":"$C"},{"x":9,"y":3,"color":"$C"},{"x":10,"y":3,"color":"$C"},
    {"x":3,"y":4,"color":"$C"},{"x":4,"y":4,"color":"$C"},{"x":10,"y":4,"color":"$C"},{"x":11,"y":4,"color":"$C"},
    {"x":2,"y":5,"color":"$C"},{"x":3,"y":5,"color":"$C"},{"x":11,"y":5,"color":"$C"},{"x":12,"y":5,"color":"$C"},
    {"x":2,"y":6,"color":"$C"},{"x":5,"y":6,"color":"$C"},{"x":6,"y":6,"color":"$C"},{"x":7,"y":6,"color":"$C"},{"x":8,"y":6,"color":"$C"},{"x":9,"y":6,"color":"$C"},{"x":12,"y":6,"color":"$C"},
    {"x":2,"y":7,"color":"$C"},{"x":4,"y":7,"color":"$C"},{"x":7,"y":7,"color":"$C"},{"x":10,"y":7,"color":"$C"},{"x":12,"y":7,"color":"$C"},
    {"x":2,"y":8,"color":"$C"},{"x":4,"y":8,"color":"$C"},{"x":6,"y":8,"color":"$C"},{"x":7,"y":8,"color":"$C"},{"x":8,"y":8,"color":"$C"},{"x":10,"y":8,"color":"$C"},{"x":12,"y":8,"color":"$C"},
    {"x":2,"y":9,"color":"$C"},{"x":4,"y":9,"color":"$C"},{"x":7,"y":9,"color":"$C"},{"x":10,"y":9,"color":"$C"},{"x":12,"y":9,"color":"$C"},
    {"x":2,"y":10,"color":"$C"},{"x":5,"y":10,"color":"$C"},{"x":6,"y":10,"color":"$C"},{"x":7,"y":10,"color":"$C"},{"x":8,"y":10,"color":"$C"},{"x":9,"y":10,"color":"$C"},{"x":12,"y":10,"color":"$C"},
    {"x":2,"y":11,"color":"$C"},{"x":3,"y":11,"color":"$C"},{"x":11,"y":11,"color":"$C"},{"x":12,"y":11,"color":"$C"},
    {"x":3,"y":12,"color":"$C"},{"x":4,"y":12,"color":"$C"},{"x":10,"y":12,"color":"$C"},{"x":11,"y":12,"color":"$C"},
    {"x":4,"y":13,"color":"$C"},{"x":5,"y":13,"color":"$C"},{"x":6,"y":13,"color":"$C"},{"x":7,"y":13,"color":"$C"},{"x":8,"y":13,"color":"$C"},{"x":9,"y":13,"color":"$C"},{"x":10,"y":13,"color":"$C"}
  ]
}
EOF

# Ghost - Frame 1
cat > /tmp/cr-ghost-1.json << EOF
{
  "width":15,"height":15,"background":"transparent","pixel_size":1,"grid_lines":false,
  "pixels":[
    {"x":5,"y":0,"color":"$C"},{"x":6,"y":0,"color":"$C"},{"x":7,"y":0,"color":"$C"},{"x":8,"y":0,"color":"$C"},{"x":9,"y":0,"color":"$C"},
    {"x":4,"y":1,"color":"$C"},{"x":5,"y":1,"color":"$C"},{"x":6,"y":1,"color":"$C"},{"x":7,"y":1,"color":"$C"},{"x":8,"y":1,"color":"$C"},{"x":9,"y":1,"color":"$C"},{"x":10,"y":1,"color":"$C"},
    {"x":3,"y":2,"color":"$C"},{"x":4,"y":2,"color":"$C"},{"x":5,"y":2,"color":"$C"},{"x":6,"y":2,"color":"$C"},{"x":7,"y":2,"color":"$C"},{"x":8,"y":2,"color":"$C"},{"x":9,"y":2,"color":"$C"},{"x":10,"y":2,"color":"$C"},{"x":11,"y":2,"color":"$C"},
    {"x":3,"y":3,"color":"$C"},{"x":4,"y":3,"color":"$C"},{"x":5,"y":3,"color":"$C"},{"x":6,"y":3,"color":"$C"},{"x":7,"y":3,"color":"$C"},{"x":8,"y":3,"color":"$C"},{"x":9,"y":3,"color":"$C"},{"x":10,"y":3,"color":"$C"},{"x":11,"y":3,"color":"$C"},
    {"x":3,"y":4,"color":"$C"},{"x":4,"y":4,"color":"$C"},{"x":6,"y":4,"color":"$C"},{"x":7,"y":4,"color":"$C"},{"x":9,"y":4,"color":"$C"},{"x":10,"y":4,"color":"$C"},{"x":11,"y":4,"color":"$C"},
    {"x":3,"y":5,"color":"$C"},{"x":4,"y":5,"color":"$C"},{"x":6,"y":5,"color":"$C"},{"x":7,"y":5,"color":"$C"},{"x":9,"y":5,"color":"$C"},{"x":10,"y":5,"color":"$C"},{"x":11,"y":5,"color":"$C"},
    {"x":3,"y":6,"color":"$C"},{"x":4,"y":6,"color":"$C"},{"x":5,"y":6,"color":"$C"},{"x":6,"y":6,"color":"$C"},{"x":7,"y":6,"color":"$C"},{"x":8,"y":6,"color":"$C"},{"x":9,"y":6,"color":"$C"},{"x":10,"y":6,"color":"$C"},{"x":11,"y":6,"color":"$C"},
    {"x":3,"y":7,"color":"$C"},{"x":4,"y":7,"color":"$C"},{"x":5,"y":7,"color":"$C"},{"x":6,"y":7,"color":"$C"},{"x":7,"y":7,"color":"$C"},{"x":8,"y":7,"color":"$C"},{"x":9,"y":7,"color":"$C"},{"x":10,"y":7,"color":"$C"},{"x":11,"y":7,"color":"$C"},
    {"x":3,"y":8,"color":"$C"},{"x":4,"y":8,"color":"$C"},{"x":5,"y":8,"color":"$C"},{"x":6,"y":8,"color":"$C"},{"x":7,"y":8,"color":"$C"},{"x":8,"y":8,"color":"$C"},{"x":9,"y":8,"color":"$C"},{"x":10,"y":8,"color":"$C"},{"x":11,"y":8,"color":"$C"},
    {"x":3,"y":9,"color":"$C"},{"x":4,"y":9,"color":"$C"},{"x":5,"y":9,"color":"$C"},{"x":6,"y":9,"color":"$C"},{"x":7,"y":9,"color":"$C"},{"x":8,"y":9,"color":"$C"},{"x":9,"y":9,"color":"$C"},{"x":10,"y":9,"color":"$C"},{"x":11,"y":9,"color":"$C"},
    {"x":3,"y":10,"color":"$C"},{"x":4,"y":10,"color":"$C"},{"x":5,"y":10,"color":"$C"},{"x":6,"y":10,"color":"$C"},{"x":7,"y":10,"color":"$C"},{"x":8,"y":10,"color":"$C"},{"x":9,"y":10,"color":"$C"},{"x":10,"y":10,"color":"$C"},{"x":11,"y":10,"color":"$C"},
    {"x":3,"y":11,"color":"$C"},{"x":5,"y":11,"color":"$C"},{"x":6,"y":11,"color":"$C"},{"x":8,"y":11,"color":"$C"},{"x":9,"y":11,"color":"$C"},{"x":11,"y":11,"color":"$C"},
    {"x":3,"y":12,"color":"$C"},{"x":7,"y":12,"color":"$C"},{"x":11,"y":12,"color":"$C"}
  ]
}
EOF

# Ghost - Frame 2 (bob down)
cat > /tmp/cr-ghost-2.json << EOF
{
  "width":15,"height":15,"background":"transparent","pixel_size":1,"grid_lines":false,
  "pixels":[
    {"x":5,"y":1,"color":"$C"},{"x":6,"y":1,"color":"$C"},{"x":7,"y":1,"color":"$C"},{"x":8,"y":1,"color":"$C"},{"x":9,"y":1,"color":"$C"},
    {"x":4,"y":2,"color":"$C"},{"x":5,"y":2,"color":"$C"},{"x":6,"y":2,"color":"$C"},{"x":7,"y":2,"color":"$C"},{"x":8,"y":2,"color":"$C"},{"x":9,"y":2,"color":"$C"},{"x":10,"y":2,"color":"$C"},
    {"x":3,"y":3,"color":"$C"},{"x":4,"y":3,"color":"$C"},{"x":5,"y":3,"color":"$C"},{"x":6,"y":3,"color":"$C"},{"x":7,"y":3,"color":"$C"},{"x":8,"y":3,"color":"$C"},{"x":9,"y":3,"color":"$C"},{"x":10,"y":3,"color":"$C"},{"x":11,"y":3,"color":"$C"},
    {"x":3,"y":4,"color":"$C"},{"x":4,"y":4,"color":"$C"},{"x":5,"y":4,"color":"$C"},{"x":6,"y":4,"color":"$C"},{"x":7,"y":4,"color":"$C"},{"x":8,"y":4,"color":"$C"},{"x":9,"y":4,"color":"$C"},{"x":10,"y":4,"color":"$C"},{"x":11,"y":4,"color":"$C"},
    {"x":3,"y":5,"color":"$C"},{"x":4,"y":5,"color":"$C"},{"x":6,"y":5,"color":"$C"},{"x":7,"y":5,"color":"$C"},{"x":9,"y":5,"color":"$C"},{"x":10,"y":5,"color":"$C"},{"x":11,"y":5,"color":"$C"},
    {"x":3,"y":6,"color":"$C"},{"x":4,"y":6,"color":"$C"},{"x":6,"y":6,"color":"$C"},{"x":7,"y":6,"color":"$C"},{"x":9,"y":6,"color":"$C"},{"x":10,"y":6,"color":"$C"},{"x":11,"y":6,"color":"$C"},
    {"x":3,"y":7,"color":"$C"},{"x":4,"y":7,"color":"$C"},{"x":5,"y":7,"color":"$C"},{"x":6,"y":7,"color":"$C"},{"x":7,"y":7,"color":"$C"},{"x":8,"y":7,"color":"$C"},{"x":9,"y":7,"color":"$C"},{"x":10,"y":7,"color":"$C"},{"x":11,"y":7,"color":"$C"},
    {"x":3,"y":8,"color":"$C"},{"x":4,"y":8,"color":"$C"},{"x":5,"y":8,"color":"$C"},{"x":6,"y":8,"color":"$C"},{"x":7,"y":8,"color":"$C"},{"x":8,"y":8,"color":"$C"},{"x":9,"y":8,"color":"$C"},{"x":10,"y":8,"color":"$C"},{"x":11,"y":8,"color":"$C"},
    {"x":3,"y":9,"color":"$C"},{"x":4,"y":9,"color":"$C"},{"x":5,"y":9,"color":"$C"},{"x":6,"y":9,"color":"$C"},{"x":7,"y":9,"color":"$C"},{"x":8,"y":9,"color":"$C"},{"x":9,"y":9,"color":"$C"},{"x":10,"y":9,"color":"$C"},{"x":11,"y":9,"color":"$C"},
    {"x":3,"y":10,"color":"$C"},{"x":4,"y":10,"color":"$C"},{"x":5,"y":10,"color":"$C"},{"x":6,"y":10,"color":"$C"},{"x":7,"y":10,"color":"$C"},{"x":8,"y":10,"color":"$C"},{"x":9,"y":10,"color":"$C"},{"x":10,"y":10,"color":"$C"},{"x":11,"y":10,"color":"$C"},
    {"x":3,"y":11,"color":"$C"},{"x":4,"y":11,"color":"$C"},{"x":5,"y":11,"color":"$C"},{"x":6,"y":11,"color":"$C"},{"x":7,"y":11,"color":"$C"},{"x":8,"y":11,"color":"$C"},{"x":9,"y":11,"color":"$C"},{"x":10,"y":11,"color":"$C"},{"x":11,"y":11,"color":"$C"},
    {"x":4,"y":12,"color":"$C"},{"x":5,"y":12,"color":"$C"},{"x":7,"y":12,"color":"$C"},{"x":9,"y":12,"color":"$C"},{"x":10,"y":12,"color":"$C"},
    {"x":4,"y":13,"color":"$C"},{"x":7,"y":13,"color":"$C"},{"x":10,"y":13,"color":"$C"}
  ]
}
EOF

# Cat - Frame 1
cat > /tmp/cr-cat-1.json << EOF
{
  "width":15,"height":15,"background":"transparent","pixel_size":1,"grid_lines":false,
  "pixels":[
    {"x":3,"y":1,"color":"$C"},{"x":11,"y":1,"color":"$C"},
    {"x":3,"y":2,"color":"$C"},{"x":4,"y":2,"color":"$C"},{"x":10,"y":2,"color":"$C"},{"x":11,"y":2,"color":"$C"},
    {"x":3,"y":3,"color":"$C"},{"x":4,"y":3,"color":"$C"},{"x":5,"y":3,"color":"$C"},{"x":9,"y":3,"color":"$C"},{"x":10,"y":3,"color":"$C"},{"x":11,"y":3,"color":"$C"},
    {"x":3,"y":4,"color":"$C"},{"x":4,"y":4,"color":"$C"},{"x":5,"y":4,"color":"$C"},{"x":6,"y":4,"color":"$C"},{"x":7,"y":4,"color":"$C"},{"x":8,"y":4,"color":"$C"},{"x":9,"y":4,"color":"$C"},{"x":10,"y":4,"color":"$C"},{"x":11,"y":4,"color":"$C"},
    {"x":3,"y":5,"color":"$C"},{"x":4,"y":5,"color":"$C"},{"x":5,"y":5,"color":"$C"},{"x":6,"y":5,"color":"$C"},{"x":7,"y":5,"color":"$C"},{"x":8,"y":5,"color":"$C"},{"x":9,"y":5,"color":"$C"},{"x":10,"y":5,"color":"$C"},{"x":11,"y":5,"color":"$C"},
    {"x":4,"y":6,"color":"$C"},{"x":5,"y":6,"color":"$C"},{"x":7,"y":6,"color":"$C"},{"x":9,"y":6,"color":"$C"},{"x":10,"y":6,"color":"$C"},
    {"x":3,"y":7,"color":"$C"},{"x":4,"y":7,"color":"$C"},{"x":5,"y":7,"color":"$C"},{"x":6,"y":7,"color":"$C"},{"x":7,"y":7,"color":"$C"},{"x":8,"y":7,"color":"$C"},{"x":9,"y":7,"color":"$C"},{"x":10,"y":7,"color":"$C"},{"x":11,"y":7,"color":"$C"},
    {"x":4,"y":8,"color":"$C"},{"x":5,"y":8,"color":"$C"},{"x":6,"y":8,"color":"$C"},{"x":7,"y":8,"color":"$C"},{"x":8,"y":8,"color":"$C"},{"x":9,"y":8,"color":"$C"},{"x":10,"y":8,"color":"$C"},
    {"x":1,"y":9,"color":"$C"},{"x":4,"y":9,"color":"$C"},{"x":5,"y":9,"color":"$C"},{"x":6,"y":9,"color":"$C"},{"x":7,"y":9,"color":"$C"},{"x":8,"y":9,"color":"$C"},{"x":9,"y":9,"color":"$C"},{"x":10,"y":9,"color":"$C"},{"x":13,"y":9,"color":"$C"},
    {"x":2,"y":10,"color":"$C"},{"x":3,"y":10,"color":"$C"},{"x":4,"y":10,"color":"$C"},{"x":5,"y":10,"color":"$C"},{"x":6,"y":10,"color":"$C"},{"x":7,"y":10,"color":"$C"},{"x":8,"y":10,"color":"$C"},{"x":9,"y":10,"color":"$C"},{"x":10,"y":10,"color":"$C"},{"x":11,"y":10,"color":"$C"},{"x":12,"y":10,"color":"$C"},
    {"x":4,"y":11,"color":"$C"},{"x":5,"y":11,"color":"$C"},{"x":6,"y":11,"color":"$C"},{"x":7,"y":11,"color":"$C"},{"x":8,"y":11,"color":"$C"},{"x":9,"y":11,"color":"$C"},{"x":10,"y":11,"color":"$C"},
    {"x":4,"y":12,"color":"$C"},{"x":5,"y":12,"color":"$C"},{"x":9,"y":12,"color":"$C"},{"x":10,"y":12,"color":"$C"}
  ]
}
EOF

# Cat - Frame 2
cat > /tmp/cr-cat-2.json << EOF
{
  "width":15,"height":15,"background":"transparent","pixel_size":1,"grid_lines":false,
  "pixels":[
    {"x":3,"y":1,"color":"$C"},{"x":11,"y":1,"color":"$C"},
    {"x":2,"y":2,"color":"$C"},{"x":3,"y":2,"color":"$C"},{"x":11,"y":2,"color":"$C"},{"x":12,"y":2,"color":"$C"},
    {"x":3,"y":3,"color":"$C"},{"x":4,"y":3,"color":"$C"},{"x":5,"y":3,"color":"$C"},{"x":9,"y":3,"color":"$C"},{"x":10,"y":3,"color":"$C"},{"x":11,"y":3,"color":"$C"},
    {"x":3,"y":4,"color":"$C"},{"x":4,"y":4,"color":"$C"},{"x":5,"y":4,"color":"$C"},{"x":6,"y":4,"color":"$C"},{"x":7,"y":4,"color":"$C"},{"x":8,"y":4,"color":"$C"},{"x":9,"y":4,"color":"$C"},{"x":10,"y":4,"color":"$C"},{"x":11,"y":4,"color":"$C"},
    {"x":3,"y":5,"color":"$C"},{"x":4,"y":5,"color":"$C"},{"x":5,"y":5,"color":"$C"},{"x":6,"y":5,"color":"$C"},{"x":7,"y":5,"color":"$C"},{"x":8,"y":5,"color":"$C"},{"x":9,"y":5,"color":"$C"},{"x":10,"y":5,"color":"$C"},{"x":11,"y":5,"color":"$C"},
    {"x":4,"y":6,"color":"$C"},{"x":5,"y":6,"color":"$C"},{"x":7,"y":6,"color":"$C"},{"x":9,"y":6,"color":"$C"},{"x":10,"y":6,"color":"$C"},
    {"x":3,"y":7,"color":"$C"},{"x":4,"y":7,"color":"$C"},{"x":5,"y":7,"color":"$C"},{"x":6,"y":7,"color":"$C"},{"x":7,"y":7,"color":"$C"},{"x":8,"y":7,"color":"$C"},{"x":9,"y":7,"color":"$C"},{"x":10,"y":7,"color":"$C"},{"x":11,"y":7,"color":"$C"},
    {"x":4,"y":8,"color":"$C"},{"x":5,"y":8,"color":"$C"},{"x":6,"y":8,"color":"$C"},{"x":7,"y":8,"color":"$C"},{"x":8,"y":8,"color":"$C"},{"x":9,"y":8,"color":"$C"},{"x":10,"y":8,"color":"$C"},
    {"x":0,"y":9,"color":"$C"},{"x":4,"y":9,"color":"$C"},{"x":5,"y":9,"color":"$C"},{"x":6,"y":9,"color":"$C"},{"x":7,"y":9,"color":"$C"},{"x":8,"y":9,"color":"$C"},{"x":9,"y":9,"color":"$C"},{"x":10,"y":9,"color":"$C"},{"x":14,"y":9,"color":"$C"},
    {"x":2,"y":10,"color":"$C"},{"x":3,"y":10,"color":"$C"},{"x":4,"y":10,"color":"$C"},{"x":5,"y":10,"color":"$C"},{"x":6,"y":10,"color":"$C"},{"x":7,"y":10,"color":"$C"},{"x":8,"y":10,"color":"$C"},{"x":9,"y":10,"color":"$C"},{"x":10,"y":10,"color":"$C"},{"x":11,"y":10,"color":"$C"},{"x":12,"y":10,"color":"$C"},
    {"x":4,"y":11,"color":"$C"},{"x":5,"y":11,"color":"$C"},{"x":6,"y":11,"color":"$C"},{"x":7,"y":11,"color":"$C"},{"x":8,"y":11,"color":"$C"},{"x":9,"y":11,"color":"$C"},{"x":10,"y":11,"color":"$C"},
    {"x":4,"y":12,"color":"$C"},{"x":5,"y":12,"color":"$C"},{"x":9,"y":12,"color":"$C"},{"x":10,"y":12,"color":"$C"}
  ]
}
EOF

# Skull - Frame 1
cat > /tmp/cr-skull-1.json << EOF
{
  "width":15,"height":15,"background":"transparent","pixel_size":1,"grid_lines":false,
  "pixels":[
    {"x":4,"y":0,"color":"$C"},{"x":5,"y":0,"color":"$C"},{"x":6,"y":0,"color":"$C"},{"x":7,"y":0,"color":"$C"},{"x":8,"y":0,"color":"$C"},{"x":9,"y":0,"color":"$C"},{"x":10,"y":0,"color":"$C"},
    {"x":3,"y":1,"color":"$C"},{"x":4,"y":1,"color":"$C"},{"x":5,"y":1,"color":"$C"},{"x":6,"y":1,"color":"$C"},{"x":7,"y":1,"color":"$C"},{"x":8,"y":1,"color":"$C"},{"x":9,"y":1,"color":"$C"},{"x":10,"y":1,"color":"$C"},{"x":11,"y":1,"color":"$C"},
    {"x":3,"y":2,"color":"$C"},{"x":4,"y":2,"color":"$C"},{"x":5,"y":2,"color":"$C"},{"x":6,"y":2,"color":"$C"},{"x":7,"y":2,"color":"$C"},{"x":8,"y":2,"color":"$C"},{"x":9,"y":2,"color":"$C"},{"x":10,"y":2,"color":"$C"},{"x":11,"y":2,"color":"$C"},
    {"x":3,"y":3,"color":"$C"},{"x":4,"y":3,"color":"$C"},{"x":7,"y":3,"color":"$C"},{"x":10,"y":3,"color":"$C"},{"x":11,"y":3,"color":"$C"},
    {"x":3,"y":4,"color":"$C"},{"x":4,"y":4,"color":"$C"},{"x":7,"y":4,"color":"$C"},{"x":10,"y":4,"color":"$C"},{"x":11,"y":4,"color":"$C"},
    {"x":3,"y":5,"color":"$C"},{"x":4,"y":5,"color":"$C"},{"x":5,"y":5,"color":"$C"},{"x":6,"y":5,"color":"$C"},{"x":7,"y":5,"color":"$C"},{"x":8,"y":5,"color":"$C"},{"x":9,"y":5,"color":"$C"},{"x":10,"y":5,"color":"$C"},{"x":11,"y":5,"color":"$C"},
    {"x":4,"y":6,"color":"$C"},{"x":5,"y":6,"color":"$C"},{"x":6,"y":6,"color":"$C"},{"x":7,"y":6,"color":"$C"},{"x":8,"y":6,"color":"$C"},{"x":9,"y":6,"color":"$C"},{"x":10,"y":6,"color":"$C"},
    {"x":4,"y":7,"color":"$C"},{"x":6,"y":7,"color":"$C"},{"x":7,"y":7,"color":"$C"},{"x":8,"y":7,"color":"$C"},{"x":10,"y":7,"color":"$C"},
    {"x":5,"y":8,"color":"$C"},{"x":6,"y":8,"color":"$C"},{"x":7,"y":8,"color":"$C"},{"x":8,"y":8,"color":"$C"},{"x":9,"y":8,"color":"$C"},
    {"x":1,"y":10,"color":"$C"},{"x":2,"y":10,"color":"$C"},{"x":3,"y":10,"color":"$C"},{"x":4,"y":10,"color":"$C"},{"x":5,"y":10,"color":"$C"},{"x":6,"y":10,"color":"$C"},{"x":7,"y":10,"color":"$C"},{"x":8,"y":10,"color":"$C"},{"x":9,"y":10,"color":"$C"},{"x":10,"y":10,"color":"$C"},{"x":11,"y":10,"color":"$C"},{"x":12,"y":10,"color":"$C"},{"x":13,"y":10,"color":"$C"},
    {"x":2,"y":11,"color":"$C"},{"x":7,"y":11,"color":"$C"},{"x":12,"y":11,"color":"$C"},
    {"x":1,"y":12,"color":"$C"},{"x":13,"y":12,"color":"$C"}
  ]
}
EOF

# Skull - Frame 2
cat > /tmp/cr-skull-2.json << EOF
{
  "width":15,"height":15,"background":"transparent","pixel_size":1,"grid_lines":false,
  "pixels":[
    {"x":4,"y":0,"color":"$C"},{"x":5,"y":0,"color":"$C"},{"x":6,"y":0,"color":"$C"},{"x":7,"y":0,"color":"$C"},{"x":8,"y":0,"color":"$C"},{"x":9,"y":0,"color":"$C"},{"x":10,"y":0,"color":"$C"},
    {"x":3,"y":1,"color":"$C"},{"x":4,"y":1,"color":"$C"},{"x":5,"y":1,"color":"$C"},{"x":6,"y":1,"color":"$C"},{"x":7,"y":1,"color":"$C"},{"x":8,"y":1,"color":"$C"},{"x":9,"y":1,"color":"$C"},{"x":10,"y":1,"color":"$C"},{"x":11,"y":1,"color":"$C"},
    {"x":3,"y":2,"color":"$C"},{"x":4,"y":2,"color":"$C"},{"x":5,"y":2,"color":"$C"},{"x":6,"y":2,"color":"$C"},{"x":7,"y":2,"color":"$C"},{"x":8,"y":2,"color":"$C"},{"x":9,"y":2,"color":"$C"},{"x":10,"y":2,"color":"$C"},{"x":11,"y":2,"color":"$C"},
    {"x":3,"y":3,"color":"$C"},{"x":4,"y":3,"color":"$C"},{"x":7,"y":3,"color":"$C"},{"x":10,"y":3,"color":"$C"},{"x":11,"y":3,"color":"$C"},
    {"x":3,"y":4,"color":"$C"},{"x":4,"y":4,"color":"$C"},{"x":7,"y":4,"color":"$C"},{"x":10,"y":4,"color":"$C"},{"x":11,"y":4,"color":"$C"},
    {"x":3,"y":5,"color":"$C"},{"x":4,"y":5,"color":"$C"},{"x":5,"y":5,"color":"$C"},{"x":6,"y":5,"color":"$C"},{"x":7,"y":5,"color":"$C"},{"x":8,"y":5,"color":"$C"},{"x":9,"y":5,"color":"$C"},{"x":10,"y":5,"color":"$C"},{"x":11,"y":5,"color":"$C"},
    {"x":4,"y":6,"color":"$C"},{"x":5,"y":6,"color":"$C"},{"x":6,"y":6,"color":"$C"},{"x":7,"y":6,"color":"$C"},{"x":8,"y":6,"color":"$C"},{"x":9,"y":6,"color":"$C"},{"x":10,"y":6,"color":"$C"},
    {"x":5,"y":7,"color":"$C"},{"x":6,"y":7,"color":"$C"},{"x":7,"y":7,"color":"$C"},{"x":9,"y":7,"color":"$C"},
    {"x":5,"y":8,"color":"$C"},{"x":6,"y":8,"color":"$C"},{"x":7,"y":8,"color":"$C"},{"x":8,"y":8,"color":"$C"},{"x":9,"y":8,"color":"$C"},
    {"x":1,"y":10,"color":"$C"},{"x":2,"y":10,"color":"$C"},{"x":3,"y":10,"color":"$C"},{"x":4,"y":10,"color":"$C"},{"x":5,"y":10,"color":"$C"},{"x":6,"y":10,"color":"$C"},{"x":7,"y":10,"color":"$C"},{"x":8,"y":10,"color":"$C"},{"x":9,"y":10,"color":"$C"},{"x":10,"y":10,"color":"$C"},{"x":11,"y":10,"color":"$C"},{"x":12,"y":10,"color":"$C"},{"x":13,"y":10,"color":"$C"},
    {"x":3,"y":11,"color":"$C"},{"x":7,"y":11,"color":"$C"},{"x":11,"y":11,"color":"$C"},
    {"x":2,"y":12,"color":"$C"},{"x":12,"y":12,"color":"$C"}
  ]
}
EOF

# Blob - Frame 1
cat > /tmp/cr-blob-1.json << EOF
{
  "width":15,"height":15,"background":"transparent","pixel_size":1,"grid_lines":false,
  "pixels":[
    {"x":5,"y":3,"color":"$C"},{"x":6,"y":3,"color":"$C"},{"x":7,"y":3,"color":"$C"},{"x":8,"y":3,"color":"$C"},{"x":9,"y":3,"color":"$C"},
    {"x":4,"y":4,"color":"$C"},{"x":5,"y":4,"color":"$C"},{"x":6,"y":4,"color":"$C"},{"x":7,"y":4,"color":"$C"},{"x":8,"y":4,"color":"$C"},{"x":9,"y":4,"color":"$C"},{"x":10,"y":4,"color":"$C"},
    {"x":3,"y":5,"color":"$C"},{"x":4,"y":5,"color":"$C"},{"x":5,"y":5,"color":"$C"},{"x":6,"y":5,"color":"$C"},{"x":7,"y":5,"color":"$C"},{"x":8,"y":5,"color":"$C"},{"x":9,"y":5,"color":"$C"},{"x":10,"y":5,"color":"$C"},{"x":11,"y":5,"color":"$C"},
    {"x":3,"y":6,"color":"$C"},{"x":4,"y":6,"color":"$C"},{"x":5,"y":6,"color":"$C"},{"x":8,"y":6,"color":"$C"},{"x":9,"y":6,"color":"$C"},{"x":10,"y":6,"color":"$C"},{"x":11,"y":6,"color":"$C"},
    {"x":3,"y":7,"color":"$C"},{"x":4,"y":7,"color":"$C"},{"x":7,"y":7,"color":"$C"},{"x":8,"y":7,"color":"$C"},{"x":9,"y":7,"color":"$C"},{"x":10,"y":7,"color":"$C"},{"x":11,"y":7,"color":"$C"},
    {"x":3,"y":8,"color":"$C"},{"x":4,"y":8,"color":"$C"},{"x":5,"y":8,"color":"$C"},{"x":6,"y":8,"color":"$C"},{"x":7,"y":8,"color":"$C"},{"x":8,"y":8,"color":"$C"},{"x":9,"y":8,"color":"$C"},{"x":10,"y":8,"color":"$C"},{"x":11,"y":8,"color":"$C"},
    {"x":2,"y":9,"color":"$C"},{"x":3,"y":9,"color":"$C"},{"x":4,"y":9,"color":"$C"},{"x":5,"y":9,"color":"$C"},{"x":6,"y":9,"color":"$C"},{"x":7,"y":9,"color":"$C"},{"x":8,"y":9,"color":"$C"},{"x":9,"y":9,"color":"$C"},{"x":10,"y":9,"color":"$C"},{"x":11,"y":9,"color":"$C"},{"x":12,"y":9,"color":"$C"},
    {"x":3,"y":10,"color":"$C"},{"x":4,"y":10,"color":"$C"},{"x":5,"y":10,"color":"$C"},{"x":6,"y":10,"color":"$C"},{"x":7,"y":10,"color":"$C"},{"x":8,"y":10,"color":"$C"},{"x":9,"y":10,"color":"$C"},{"x":10,"y":10,"color":"$C"},{"x":11,"y":10,"color":"$C"},
    {"x":4,"y":11,"color":"$C"},{"x":5,"y":11,"color":"$C"},{"x":6,"y":11,"color":"$C"},{"x":7,"y":11,"color":"$C"},{"x":8,"y":11,"color":"$C"},{"x":9,"y":11,"color":"$C"},{"x":10,"y":11,"color":"$C"}
  ]
}
EOF

# Blob - Frame 2 (squish)
cat > /tmp/cr-blob-2.json << EOF
{
  "width":15,"height":15,"background":"transparent","pixel_size":1,"grid_lines":false,
  "pixels":[
    {"x":5,"y":4,"color":"$C"},{"x":6,"y":4,"color":"$C"},{"x":7,"y":4,"color":"$C"},{"x":8,"y":4,"color":"$C"},{"x":9,"y":4,"color":"$C"},
    {"x":4,"y":5,"color":"$C"},{"x":5,"y":5,"color":"$C"},{"x":6,"y":5,"color":"$C"},{"x":7,"y":5,"color":"$C"},{"x":8,"y":5,"color":"$C"},{"x":9,"y":5,"color":"$C"},{"x":10,"y":5,"color":"$C"},
    {"x":3,"y":6,"color":"$C"},{"x":4,"y":6,"color":"$C"},{"x":5,"y":6,"color":"$C"},{"x":8,"y":6,"color":"$C"},{"x":9,"y":6,"color":"$C"},{"x":10,"y":6,"color":"$C"},{"x":11,"y":6,"color":"$C"},
    {"x":3,"y":7,"color":"$C"},{"x":4,"y":7,"color":"$C"},{"x":7,"y":7,"color":"$C"},{"x":8,"y":7,"color":"$C"},{"x":9,"y":7,"color":"$C"},{"x":10,"y":7,"color":"$C"},{"x":11,"y":7,"color":"$C"},
    {"x":2,"y":8,"color":"$C"},{"x":3,"y":8,"color":"$C"},{"x":4,"y":8,"color":"$C"},{"x":5,"y":8,"color":"$C"},{"x":6,"y":8,"color":"$C"},{"x":7,"y":8,"color":"$C"},{"x":8,"y":8,"color":"$C"},{"x":9,"y":8,"color":"$C"},{"x":10,"y":8,"color":"$C"},{"x":11,"y":8,"color":"$C"},{"x":12,"y":8,"color":"$C"},
    {"x":2,"y":9,"color":"$C"},{"x":3,"y":9,"color":"$C"},{"x":4,"y":9,"color":"$C"},{"x":5,"y":9,"color":"$C"},{"x":6,"y":9,"color":"$C"},{"x":7,"y":9,"color":"$C"},{"x":8,"y":9,"color":"$C"},{"x":9,"y":9,"color":"$C"},{"x":10,"y":9,"color":"$C"},{"x":11,"y":9,"color":"$C"},{"x":12,"y":9,"color":"$C"},
    {"x":2,"y":10,"color":"$C"},{"x":3,"y":10,"color":"$C"},{"x":4,"y":10,"color":"$C"},{"x":5,"y":10,"color":"$C"},{"x":6,"y":10,"color":"$C"},{"x":7,"y":10,"color":"$C"},{"x":8,"y":10,"color":"$C"},{"x":9,"y":10,"color":"$C"},{"x":10,"y":10,"color":"$C"},{"x":11,"y":10,"color":"$C"},{"x":12,"y":10,"color":"$C"},
    {"x":3,"y":11,"color":"$C"},{"x":4,"y":11,"color":"$C"},{"x":5,"y":11,"color":"$C"},{"x":6,"y":11,"color":"$C"},{"x":7,"y":11,"color":"$C"},{"x":8,"y":11,"color":"$C"},{"x":9,"y":11,"color":"$C"},{"x":10,"y":11,"color":"$C"},{"x":11,"y":11,"color":"$C"}
  ]
}
EOF

# Render all
for name in beholder ghost cat skull blob; do
  python3 "$RENDER" /tmp/cr-${name}-1.json -o "$OUT/${name}-1.png" -p 1 --no-grid-lines
  python3 "$RENDER" /tmp/cr-${name}-2.json -o "$OUT/${name}-2.png" -p 1 --no-grid-lines
done
echo "Done — all sprites now 15x15"
