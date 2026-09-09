#!/bin/bash
# Generate all 1-bit creature sprites using the pixel art skill's render script
RENDER="/Users/gijo/.claude/skills/pixel-art-gen/scripts/render_pixel_art.py"
OUT="/Users/gijo/Documents/Code/bitwise/web/assets/sprites"
mkdir -p "$OUT"

# Ghost - Frame 1 (16x16, white on black)
cat > /tmp/ghost-1.json << 'EOF'
{
  "width": 16, "height": 16, "background": "transparent", "pixel_size": 1, "grid_lines": false,
  "pixels": [
    {"x":6,"y":1,"color":"#FFFFFF"},{"x":7,"y":1,"color":"#FFFFFF"},{"x":8,"y":1,"color":"#FFFFFF"},{"x":9,"y":1,"color":"#FFFFFF"},
    {"x":5,"y":2,"color":"#FFFFFF"},{"x":6,"y":2,"color":"#FFFFFF"},{"x":7,"y":2,"color":"#FFFFFF"},{"x":8,"y":2,"color":"#FFFFFF"},{"x":9,"y":2,"color":"#FFFFFF"},{"x":10,"y":2,"color":"#FFFFFF"},
    {"x":4,"y":3,"color":"#FFFFFF"},{"x":5,"y":3,"color":"#FFFFFF"},{"x":6,"y":3,"color":"#FFFFFF"},{"x":7,"y":3,"color":"#FFFFFF"},{"x":8,"y":3,"color":"#FFFFFF"},{"x":9,"y":3,"color":"#FFFFFF"},{"x":10,"y":3,"color":"#FFFFFF"},{"x":11,"y":3,"color":"#FFFFFF"},
    {"x":4,"y":4,"color":"#FFFFFF"},{"x":5,"y":4,"color":"#FFFFFF"},{"x":6,"y":4,"color":"#FFFFFF"},{"x":7,"y":4,"color":"#FFFFFF"},{"x":8,"y":4,"color":"#FFFFFF"},{"x":9,"y":4,"color":"#FFFFFF"},{"x":10,"y":4,"color":"#FFFFFF"},{"x":11,"y":4,"color":"#FFFFFF"},
    {"x":4,"y":5,"color":"#FFFFFF"},{"x":5,"y":5,"color":"#FFFFFF"},{"x":7,"y":5,"color":"#FFFFFF"},{"x":8,"y":5,"color":"#FFFFFF"},{"x":10,"y":5,"color":"#FFFFFF"},{"x":11,"y":5,"color":"#FFFFFF"},
    {"x":4,"y":6,"color":"#FFFFFF"},{"x":5,"y":6,"color":"#FFFFFF"},{"x":7,"y":6,"color":"#FFFFFF"},{"x":8,"y":6,"color":"#FFFFFF"},{"x":10,"y":6,"color":"#FFFFFF"},{"x":11,"y":6,"color":"#FFFFFF"},
    {"x":4,"y":7,"color":"#FFFFFF"},{"x":5,"y":7,"color":"#FFFFFF"},{"x":6,"y":7,"color":"#FFFFFF"},{"x":7,"y":7,"color":"#FFFFFF"},{"x":8,"y":7,"color":"#FFFFFF"},{"x":9,"y":7,"color":"#FFFFFF"},{"x":10,"y":7,"color":"#FFFFFF"},{"x":11,"y":7,"color":"#FFFFFF"},
    {"x":4,"y":8,"color":"#FFFFFF"},{"x":5,"y":8,"color":"#FFFFFF"},{"x":6,"y":8,"color":"#FFFFFF"},{"x":7,"y":8,"color":"#FFFFFF"},{"x":8,"y":8,"color":"#FFFFFF"},{"x":9,"y":8,"color":"#FFFFFF"},{"x":10,"y":8,"color":"#FFFFFF"},{"x":11,"y":8,"color":"#FFFFFF"},
    {"x":4,"y":9,"color":"#FFFFFF"},{"x":5,"y":9,"color":"#FFFFFF"},{"x":6,"y":9,"color":"#FFFFFF"},{"x":7,"y":9,"color":"#FFFFFF"},{"x":8,"y":9,"color":"#FFFFFF"},{"x":9,"y":9,"color":"#FFFFFF"},{"x":10,"y":9,"color":"#FFFFFF"},{"x":11,"y":9,"color":"#FFFFFF"},
    {"x":4,"y":10,"color":"#FFFFFF"},{"x":5,"y":10,"color":"#FFFFFF"},{"x":6,"y":10,"color":"#FFFFFF"},{"x":7,"y":10,"color":"#FFFFFF"},{"x":8,"y":10,"color":"#FFFFFF"},{"x":9,"y":10,"color":"#FFFFFF"},{"x":10,"y":10,"color":"#FFFFFF"},{"x":11,"y":10,"color":"#FFFFFF"},
    {"x":4,"y":11,"color":"#FFFFFF"},{"x":5,"y":11,"color":"#FFFFFF"},{"x":6,"y":11,"color":"#FFFFFF"},{"x":7,"y":11,"color":"#FFFFFF"},{"x":8,"y":11,"color":"#FFFFFF"},{"x":9,"y":11,"color":"#FFFFFF"},{"x":10,"y":11,"color":"#FFFFFF"},{"x":11,"y":11,"color":"#FFFFFF"},
    {"x":4,"y":12,"color":"#FFFFFF"},{"x":5,"y":12,"color":"#FFFFFF"},{"x":7,"y":12,"color":"#FFFFFF"},{"x":8,"y":12,"color":"#FFFFFF"},{"x":10,"y":12,"color":"#FFFFFF"},{"x":11,"y":12,"color":"#FFFFFF"},
    {"x":4,"y":13,"color":"#FFFFFF"},{"x":8,"y":13,"color":"#FFFFFF"},{"x":11,"y":13,"color":"#FFFFFF"}
  ]
}
EOF

# Ghost - Frame 2 (shifted down 1px for bob)
cat > /tmp/ghost-2.json << 'EOF'
{
  "width": 16, "height": 16, "background": "transparent", "pixel_size": 1, "grid_lines": false,
  "pixels": [
    {"x":6,"y":2,"color":"#FFFFFF"},{"x":7,"y":2,"color":"#FFFFFF"},{"x":8,"y":2,"color":"#FFFFFF"},{"x":9,"y":2,"color":"#FFFFFF"},
    {"x":5,"y":3,"color":"#FFFFFF"},{"x":6,"y":3,"color":"#FFFFFF"},{"x":7,"y":3,"color":"#FFFFFF"},{"x":8,"y":3,"color":"#FFFFFF"},{"x":9,"y":3,"color":"#FFFFFF"},{"x":10,"y":3,"color":"#FFFFFF"},
    {"x":4,"y":4,"color":"#FFFFFF"},{"x":5,"y":4,"color":"#FFFFFF"},{"x":6,"y":4,"color":"#FFFFFF"},{"x":7,"y":4,"color":"#FFFFFF"},{"x":8,"y":4,"color":"#FFFFFF"},{"x":9,"y":4,"color":"#FFFFFF"},{"x":10,"y":4,"color":"#FFFFFF"},{"x":11,"y":4,"color":"#FFFFFF"},
    {"x":4,"y":5,"color":"#FFFFFF"},{"x":5,"y":5,"color":"#FFFFFF"},{"x":6,"y":5,"color":"#FFFFFF"},{"x":7,"y":5,"color":"#FFFFFF"},{"x":8,"y":5,"color":"#FFFFFF"},{"x":9,"y":5,"color":"#FFFFFF"},{"x":10,"y":5,"color":"#FFFFFF"},{"x":11,"y":5,"color":"#FFFFFF"},
    {"x":4,"y":6,"color":"#FFFFFF"},{"x":5,"y":6,"color":"#FFFFFF"},{"x":7,"y":6,"color":"#FFFFFF"},{"x":8,"y":6,"color":"#FFFFFF"},{"x":10,"y":6,"color":"#FFFFFF"},{"x":11,"y":6,"color":"#FFFFFF"},
    {"x":4,"y":7,"color":"#FFFFFF"},{"x":5,"y":7,"color":"#FFFFFF"},{"x":7,"y":7,"color":"#FFFFFF"},{"x":8,"y":7,"color":"#FFFFFF"},{"x":10,"y":7,"color":"#FFFFFF"},{"x":11,"y":7,"color":"#FFFFFF"},
    {"x":4,"y":8,"color":"#FFFFFF"},{"x":5,"y":8,"color":"#FFFFFF"},{"x":6,"y":8,"color":"#FFFFFF"},{"x":7,"y":8,"color":"#FFFFFF"},{"x":8,"y":8,"color":"#FFFFFF"},{"x":9,"y":8,"color":"#FFFFFF"},{"x":10,"y":8,"color":"#FFFFFF"},{"x":11,"y":8,"color":"#FFFFFF"},
    {"x":4,"y":9,"color":"#FFFFFF"},{"x":5,"y":9,"color":"#FFFFFF"},{"x":6,"y":9,"color":"#FFFFFF"},{"x":7,"y":9,"color":"#FFFFFF"},{"x":8,"y":9,"color":"#FFFFFF"},{"x":9,"y":9,"color":"#FFFFFF"},{"x":10,"y":9,"color":"#FFFFFF"},{"x":11,"y":9,"color":"#FFFFFF"},
    {"x":4,"y":10,"color":"#FFFFFF"},{"x":5,"y":10,"color":"#FFFFFF"},{"x":6,"y":10,"color":"#FFFFFF"},{"x":7,"y":10,"color":"#FFFFFF"},{"x":8,"y":10,"color":"#FFFFFF"},{"x":9,"y":10,"color":"#FFFFFF"},{"x":10,"y":10,"color":"#FFFFFF"},{"x":11,"y":10,"color":"#FFFFFF"},
    {"x":4,"y":11,"color":"#FFFFFF"},{"x":5,"y":11,"color":"#FFFFFF"},{"x":6,"y":11,"color":"#FFFFFF"},{"x":7,"y":11,"color":"#FFFFFF"},{"x":8,"y":11,"color":"#FFFFFF"},{"x":9,"y":11,"color":"#FFFFFF"},{"x":10,"y":11,"color":"#FFFFFF"},{"x":11,"y":11,"color":"#FFFFFF"},
    {"x":4,"y":12,"color":"#FFFFFF"},{"x":5,"y":12,"color":"#FFFFFF"},{"x":6,"y":12,"color":"#FFFFFF"},{"x":7,"y":12,"color":"#FFFFFF"},{"x":8,"y":12,"color":"#FFFFFF"},{"x":9,"y":12,"color":"#FFFFFF"},{"x":10,"y":12,"color":"#FFFFFF"},{"x":11,"y":12,"color":"#FFFFFF"},
    {"x":5,"y":13,"color":"#FFFFFF"},{"x":6,"y":13,"color":"#FFFFFF"},{"x":9,"y":13,"color":"#FFFFFF"},{"x":10,"y":13,"color":"#FFFFFF"},
    {"x":5,"y":14,"color":"#FFFFFF"},{"x":10,"y":14,"color":"#FFFFFF"}
  ]
}
EOF

# Cat - Frame 1
cat > /tmp/cat-1.json << 'EOF'
{
  "width": 16, "height": 16, "background": "transparent", "pixel_size": 1, "grid_lines": false,
  "pixels": [
    {"x":4,"y":1,"color":"#FFFFFF"},{"x":11,"y":1,"color":"#FFFFFF"},
    {"x":4,"y":2,"color":"#FFFFFF"},{"x":5,"y":2,"color":"#FFFFFF"},{"x":10,"y":2,"color":"#FFFFFF"},{"x":11,"y":2,"color":"#FFFFFF"},
    {"x":4,"y":3,"color":"#FFFFFF"},{"x":5,"y":3,"color":"#FFFFFF"},{"x":6,"y":3,"color":"#FFFFFF"},{"x":9,"y":3,"color":"#FFFFFF"},{"x":10,"y":3,"color":"#FFFFFF"},{"x":11,"y":3,"color":"#FFFFFF"},
    {"x":4,"y":4,"color":"#FFFFFF"},{"x":5,"y":4,"color":"#FFFFFF"},{"x":6,"y":4,"color":"#FFFFFF"},{"x":7,"y":4,"color":"#FFFFFF"},{"x":8,"y":4,"color":"#FFFFFF"},{"x":9,"y":4,"color":"#FFFFFF"},{"x":10,"y":4,"color":"#FFFFFF"},{"x":11,"y":4,"color":"#FFFFFF"},
    {"x":4,"y":5,"color":"#FFFFFF"},{"x":5,"y":5,"color":"#FFFFFF"},{"x":6,"y":5,"color":"#FFFFFF"},{"x":7,"y":5,"color":"#FFFFFF"},{"x":8,"y":5,"color":"#FFFFFF"},{"x":9,"y":5,"color":"#FFFFFF"},{"x":10,"y":5,"color":"#FFFFFF"},{"x":11,"y":5,"color":"#FFFFFF"},
    {"x":5,"y":6,"color":"#FFFFFF"},{"x":7,"y":6,"color":"#FFFFFF"},{"x":8,"y":6,"color":"#FFFFFF"},{"x":10,"y":6,"color":"#FFFFFF"},
    {"x":4,"y":7,"color":"#FFFFFF"},{"x":5,"y":7,"color":"#FFFFFF"},{"x":6,"y":7,"color":"#FFFFFF"},{"x":7,"y":7,"color":"#FFFFFF"},{"x":8,"y":7,"color":"#FFFFFF"},{"x":9,"y":7,"color":"#FFFFFF"},{"x":10,"y":7,"color":"#FFFFFF"},{"x":11,"y":7,"color":"#FFFFFF"},
    {"x":5,"y":8,"color":"#FFFFFF"},{"x":6,"y":8,"color":"#FFFFFF"},{"x":7,"y":8,"color":"#FFFFFF"},{"x":8,"y":8,"color":"#FFFFFF"},{"x":9,"y":8,"color":"#FFFFFF"},{"x":10,"y":8,"color":"#FFFFFF"},
    {"x":3,"y":9,"color":"#FFFFFF"},{"x":5,"y":9,"color":"#FFFFFF"},{"x":6,"y":9,"color":"#FFFFFF"},{"x":7,"y":9,"color":"#FFFFFF"},{"x":8,"y":9,"color":"#FFFFFF"},{"x":9,"y":9,"color":"#FFFFFF"},{"x":10,"y":9,"color":"#FFFFFF"},{"x":12,"y":9,"color":"#FFFFFF"},
    {"x":3,"y":10,"color":"#FFFFFF"},{"x":4,"y":10,"color":"#FFFFFF"},{"x":5,"y":10,"color":"#FFFFFF"},{"x":6,"y":10,"color":"#FFFFFF"},{"x":7,"y":10,"color":"#FFFFFF"},{"x":8,"y":10,"color":"#FFFFFF"},{"x":9,"y":10,"color":"#FFFFFF"},{"x":10,"y":10,"color":"#FFFFFF"},{"x":11,"y":10,"color":"#FFFFFF"},{"x":12,"y":10,"color":"#FFFFFF"},
    {"x":5,"y":11,"color":"#FFFFFF"},{"x":6,"y":11,"color":"#FFFFFF"},{"x":7,"y":11,"color":"#FFFFFF"},{"x":8,"y":11,"color":"#FFFFFF"},{"x":9,"y":11,"color":"#FFFFFF"},{"x":10,"y":11,"color":"#FFFFFF"},
    {"x":5,"y":12,"color":"#FFFFFF"},{"x":6,"y":12,"color":"#FFFFFF"},{"x":9,"y":12,"color":"#FFFFFF"},{"x":10,"y":12,"color":"#FFFFFF"},
    {"x":5,"y":13,"color":"#FFFFFF"},{"x":6,"y":13,"color":"#FFFFFF"},{"x":9,"y":13,"color":"#FFFFFF"},{"x":10,"y":13,"color":"#FFFFFF"}
  ]
}
EOF

# Cat - Frame 2 (ears twitch, whiskers shift)
cat > /tmp/cat-2.json << 'EOF'
{
  "width": 16, "height": 16, "background": "transparent", "pixel_size": 1, "grid_lines": false,
  "pixels": [
    {"x":4,"y":1,"color":"#FFFFFF"},{"x":11,"y":1,"color":"#FFFFFF"},
    {"x":3,"y":2,"color":"#FFFFFF"},{"x":4,"y":2,"color":"#FFFFFF"},{"x":11,"y":2,"color":"#FFFFFF"},{"x":12,"y":2,"color":"#FFFFFF"},
    {"x":4,"y":3,"color":"#FFFFFF"},{"x":5,"y":3,"color":"#FFFFFF"},{"x":6,"y":3,"color":"#FFFFFF"},{"x":9,"y":3,"color":"#FFFFFF"},{"x":10,"y":3,"color":"#FFFFFF"},{"x":11,"y":3,"color":"#FFFFFF"},
    {"x":4,"y":4,"color":"#FFFFFF"},{"x":5,"y":4,"color":"#FFFFFF"},{"x":6,"y":4,"color":"#FFFFFF"},{"x":7,"y":4,"color":"#FFFFFF"},{"x":8,"y":4,"color":"#FFFFFF"},{"x":9,"y":4,"color":"#FFFFFF"},{"x":10,"y":4,"color":"#FFFFFF"},{"x":11,"y":4,"color":"#FFFFFF"},
    {"x":4,"y":5,"color":"#FFFFFF"},{"x":5,"y":5,"color":"#FFFFFF"},{"x":6,"y":5,"color":"#FFFFFF"},{"x":7,"y":5,"color":"#FFFFFF"},{"x":8,"y":5,"color":"#FFFFFF"},{"x":9,"y":5,"color":"#FFFFFF"},{"x":10,"y":5,"color":"#FFFFFF"},{"x":11,"y":5,"color":"#FFFFFF"},
    {"x":5,"y":6,"color":"#FFFFFF"},{"x":7,"y":6,"color":"#FFFFFF"},{"x":8,"y":6,"color":"#FFFFFF"},{"x":10,"y":6,"color":"#FFFFFF"},
    {"x":4,"y":7,"color":"#FFFFFF"},{"x":5,"y":7,"color":"#FFFFFF"},{"x":6,"y":7,"color":"#FFFFFF"},{"x":7,"y":7,"color":"#FFFFFF"},{"x":8,"y":7,"color":"#FFFFFF"},{"x":9,"y":7,"color":"#FFFFFF"},{"x":10,"y":7,"color":"#FFFFFF"},{"x":11,"y":7,"color":"#FFFFFF"},
    {"x":5,"y":8,"color":"#FFFFFF"},{"x":6,"y":8,"color":"#FFFFFF"},{"x":7,"y":8,"color":"#FFFFFF"},{"x":8,"y":8,"color":"#FFFFFF"},{"x":9,"y":8,"color":"#FFFFFF"},{"x":10,"y":8,"color":"#FFFFFF"},
    {"x":2,"y":9,"color":"#FFFFFF"},{"x":5,"y":9,"color":"#FFFFFF"},{"x":6,"y":9,"color":"#FFFFFF"},{"x":7,"y":9,"color":"#FFFFFF"},{"x":8,"y":9,"color":"#FFFFFF"},{"x":9,"y":9,"color":"#FFFFFF"},{"x":10,"y":9,"color":"#FFFFFF"},{"x":13,"y":9,"color":"#FFFFFF"},
    {"x":3,"y":10,"color":"#FFFFFF"},{"x":4,"y":10,"color":"#FFFFFF"},{"x":5,"y":10,"color":"#FFFFFF"},{"x":6,"y":10,"color":"#FFFFFF"},{"x":7,"y":10,"color":"#FFFFFF"},{"x":8,"y":10,"color":"#FFFFFF"},{"x":9,"y":10,"color":"#FFFFFF"},{"x":10,"y":10,"color":"#FFFFFF"},{"x":11,"y":10,"color":"#FFFFFF"},{"x":12,"y":10,"color":"#FFFFFF"},
    {"x":5,"y":11,"color":"#FFFFFF"},{"x":6,"y":11,"color":"#FFFFFF"},{"x":7,"y":11,"color":"#FFFFFF"},{"x":8,"y":11,"color":"#FFFFFF"},{"x":9,"y":11,"color":"#FFFFFF"},{"x":10,"y":11,"color":"#FFFFFF"},
    {"x":5,"y":12,"color":"#FFFFFF"},{"x":6,"y":12,"color":"#FFFFFF"},{"x":9,"y":12,"color":"#FFFFFF"},{"x":10,"y":12,"color":"#FFFFFF"},
    {"x":5,"y":13,"color":"#FFFFFF"},{"x":6,"y":13,"color":"#FFFFFF"},{"x":9,"y":13,"color":"#FFFFFF"},{"x":10,"y":13,"color":"#FFFFFF"}
  ]
}
EOF

# Skull - Frame 1
cat > /tmp/skull-1.json << 'EOF'
{
  "width": 16, "height": 16, "background": "transparent", "pixel_size": 1, "grid_lines": false,
  "pixels": [
    {"x":5,"y":1,"color":"#FFFFFF"},{"x":6,"y":1,"color":"#FFFFFF"},{"x":7,"y":1,"color":"#FFFFFF"},{"x":8,"y":1,"color":"#FFFFFF"},{"x":9,"y":1,"color":"#FFFFFF"},{"x":10,"y":1,"color":"#FFFFFF"},
    {"x":4,"y":2,"color":"#FFFFFF"},{"x":5,"y":2,"color":"#FFFFFF"},{"x":6,"y":2,"color":"#FFFFFF"},{"x":7,"y":2,"color":"#FFFFFF"},{"x":8,"y":2,"color":"#FFFFFF"},{"x":9,"y":2,"color":"#FFFFFF"},{"x":10,"y":2,"color":"#FFFFFF"},{"x":11,"y":2,"color":"#FFFFFF"},
    {"x":4,"y":3,"color":"#FFFFFF"},{"x":5,"y":3,"color":"#FFFFFF"},{"x":6,"y":3,"color":"#FFFFFF"},{"x":7,"y":3,"color":"#FFFFFF"},{"x":8,"y":3,"color":"#FFFFFF"},{"x":9,"y":3,"color":"#FFFFFF"},{"x":10,"y":3,"color":"#FFFFFF"},{"x":11,"y":3,"color":"#FFFFFF"},
    {"x":4,"y":4,"color":"#FFFFFF"},{"x":5,"y":4,"color":"#FFFFFF"},{"x":8,"y":4,"color":"#FFFFFF"},{"x":10,"y":4,"color":"#FFFFFF"},{"x":11,"y":4,"color":"#FFFFFF"},
    {"x":4,"y":5,"color":"#FFFFFF"},{"x":5,"y":5,"color":"#FFFFFF"},{"x":8,"y":5,"color":"#FFFFFF"},{"x":10,"y":5,"color":"#FFFFFF"},{"x":11,"y":5,"color":"#FFFFFF"},
    {"x":4,"y":6,"color":"#FFFFFF"},{"x":5,"y":6,"color":"#FFFFFF"},{"x":6,"y":6,"color":"#FFFFFF"},{"x":7,"y":6,"color":"#FFFFFF"},{"x":8,"y":6,"color":"#FFFFFF"},{"x":9,"y":6,"color":"#FFFFFF"},{"x":10,"y":6,"color":"#FFFFFF"},{"x":11,"y":6,"color":"#FFFFFF"},
    {"x":5,"y":7,"color":"#FFFFFF"},{"x":6,"y":7,"color":"#FFFFFF"},{"x":7,"y":7,"color":"#FFFFFF"},{"x":8,"y":7,"color":"#FFFFFF"},{"x":9,"y":7,"color":"#FFFFFF"},{"x":10,"y":7,"color":"#FFFFFF"},
    {"x":5,"y":8,"color":"#FFFFFF"},{"x":7,"y":8,"color":"#FFFFFF"},{"x":9,"y":8,"color":"#FFFFFF"},{"x":10,"y":8,"color":"#FFFFFF"},
    {"x":6,"y":9,"color":"#FFFFFF"},{"x":7,"y":9,"color":"#FFFFFF"},{"x":8,"y":9,"color":"#FFFFFF"},{"x":9,"y":9,"color":"#FFFFFF"},
    {"x":2,"y":11,"color":"#FFFFFF"},{"x":3,"y":11,"color":"#FFFFFF"},{"x":4,"y":11,"color":"#FFFFFF"},{"x":5,"y":11,"color":"#FFFFFF"},{"x":6,"y":11,"color":"#FFFFFF"},{"x":7,"y":11,"color":"#FFFFFF"},{"x":8,"y":11,"color":"#FFFFFF"},{"x":9,"y":11,"color":"#FFFFFF"},{"x":10,"y":11,"color":"#FFFFFF"},{"x":11,"y":11,"color":"#FFFFFF"},{"x":12,"y":11,"color":"#FFFFFF"},{"x":13,"y":11,"color":"#FFFFFF"},
    {"x":3,"y":12,"color":"#FFFFFF"},{"x":7,"y":12,"color":"#FFFFFF"},{"x":8,"y":12,"color":"#FFFFFF"},{"x":12,"y":12,"color":"#FFFFFF"},
    {"x":2,"y":13,"color":"#FFFFFF"},{"x":13,"y":13,"color":"#FFFFFF"}
  ]
}
EOF

# Skull - Frame 2 (jaw shifts)
cat > /tmp/skull-2.json << 'EOF'
{
  "width": 16, "height": 16, "background": "transparent", "pixel_size": 1, "grid_lines": false,
  "pixels": [
    {"x":5,"y":1,"color":"#FFFFFF"},{"x":6,"y":1,"color":"#FFFFFF"},{"x":7,"y":1,"color":"#FFFFFF"},{"x":8,"y":1,"color":"#FFFFFF"},{"x":9,"y":1,"color":"#FFFFFF"},{"x":10,"y":1,"color":"#FFFFFF"},
    {"x":4,"y":2,"color":"#FFFFFF"},{"x":5,"y":2,"color":"#FFFFFF"},{"x":6,"y":2,"color":"#FFFFFF"},{"x":7,"y":2,"color":"#FFFFFF"},{"x":8,"y":2,"color":"#FFFFFF"},{"x":9,"y":2,"color":"#FFFFFF"},{"x":10,"y":2,"color":"#FFFFFF"},{"x":11,"y":2,"color":"#FFFFFF"},
    {"x":4,"y":3,"color":"#FFFFFF"},{"x":5,"y":3,"color":"#FFFFFF"},{"x":6,"y":3,"color":"#FFFFFF"},{"x":7,"y":3,"color":"#FFFFFF"},{"x":8,"y":3,"color":"#FFFFFF"},{"x":9,"y":3,"color":"#FFFFFF"},{"x":10,"y":3,"color":"#FFFFFF"},{"x":11,"y":3,"color":"#FFFFFF"},
    {"x":4,"y":4,"color":"#FFFFFF"},{"x":5,"y":4,"color":"#FFFFFF"},{"x":8,"y":4,"color":"#FFFFFF"},{"x":10,"y":4,"color":"#FFFFFF"},{"x":11,"y":4,"color":"#FFFFFF"},
    {"x":4,"y":5,"color":"#FFFFFF"},{"x":5,"y":5,"color":"#FFFFFF"},{"x":8,"y":5,"color":"#FFFFFF"},{"x":10,"y":5,"color":"#FFFFFF"},{"x":11,"y":5,"color":"#FFFFFF"},
    {"x":4,"y":6,"color":"#FFFFFF"},{"x":5,"y":6,"color":"#FFFFFF"},{"x":6,"y":6,"color":"#FFFFFF"},{"x":7,"y":6,"color":"#FFFFFF"},{"x":8,"y":6,"color":"#FFFFFF"},{"x":9,"y":6,"color":"#FFFFFF"},{"x":10,"y":6,"color":"#FFFFFF"},{"x":11,"y":6,"color":"#FFFFFF"},
    {"x":5,"y":7,"color":"#FFFFFF"},{"x":6,"y":7,"color":"#FFFFFF"},{"x":7,"y":7,"color":"#FFFFFF"},{"x":8,"y":7,"color":"#FFFFFF"},{"x":9,"y":7,"color":"#FFFFFF"},{"x":10,"y":7,"color":"#FFFFFF"},
    {"x":6,"y":8,"color":"#FFFFFF"},{"x":7,"y":8,"color":"#FFFFFF"},{"x":8,"y":8,"color":"#FFFFFF"},{"x":10,"y":8,"color":"#FFFFFF"},
    {"x":6,"y":9,"color":"#FFFFFF"},{"x":7,"y":9,"color":"#FFFFFF"},{"x":8,"y":9,"color":"#FFFFFF"},{"x":9,"y":9,"color":"#FFFFFF"},
    {"x":2,"y":11,"color":"#FFFFFF"},{"x":3,"y":11,"color":"#FFFFFF"},{"x":4,"y":11,"color":"#FFFFFF"},{"x":5,"y":11,"color":"#FFFFFF"},{"x":6,"y":11,"color":"#FFFFFF"},{"x":7,"y":11,"color":"#FFFFFF"},{"x":8,"y":11,"color":"#FFFFFF"},{"x":9,"y":11,"color":"#FFFFFF"},{"x":10,"y":11,"color":"#FFFFFF"},{"x":11,"y":11,"color":"#FFFFFF"},{"x":12,"y":11,"color":"#FFFFFF"},{"x":13,"y":11,"color":"#FFFFFF"},
    {"x":4,"y":12,"color":"#FFFFFF"},{"x":7,"y":12,"color":"#FFFFFF"},{"x":8,"y":12,"color":"#FFFFFF"},{"x":11,"y":12,"color":"#FFFFFF"},
    {"x":3,"y":13,"color":"#FFFFFF"},{"x":12,"y":13,"color":"#FFFFFF"}
  ]
}
EOF

# Blob (one-eye) - Frame 1
cat > /tmp/blob-1.json << 'EOF'
{
  "width": 16, "height": 16, "background": "transparent", "pixel_size": 1, "grid_lines": false,
  "pixels": [
    {"x":6,"y":3,"color":"#FFFFFF"},{"x":7,"y":3,"color":"#FFFFFF"},{"x":8,"y":3,"color":"#FFFFFF"},{"x":9,"y":3,"color":"#FFFFFF"},
    {"x":5,"y":4,"color":"#FFFFFF"},{"x":6,"y":4,"color":"#FFFFFF"},{"x":7,"y":4,"color":"#FFFFFF"},{"x":8,"y":4,"color":"#FFFFFF"},{"x":9,"y":4,"color":"#FFFFFF"},{"x":10,"y":4,"color":"#FFFFFF"},
    {"x":4,"y":5,"color":"#FFFFFF"},{"x":5,"y":5,"color":"#FFFFFF"},{"x":6,"y":5,"color":"#FFFFFF"},{"x":7,"y":5,"color":"#FFFFFF"},{"x":8,"y":5,"color":"#FFFFFF"},{"x":9,"y":5,"color":"#FFFFFF"},{"x":10,"y":5,"color":"#FFFFFF"},{"x":11,"y":5,"color":"#FFFFFF"},
    {"x":4,"y":6,"color":"#FFFFFF"},{"x":5,"y":6,"color":"#FFFFFF"},{"x":6,"y":6,"color":"#FFFFFF"},{"x":9,"y":6,"color":"#FFFFFF"},{"x":10,"y":6,"color":"#FFFFFF"},{"x":11,"y":6,"color":"#FFFFFF"},
    {"x":4,"y":7,"color":"#FFFFFF"},{"x":5,"y":7,"color":"#FFFFFF"},{"x":8,"y":7,"color":"#FFFFFF"},{"x":9,"y":7,"color":"#FFFFFF"},{"x":10,"y":7,"color":"#FFFFFF"},{"x":11,"y":7,"color":"#FFFFFF"},
    {"x":4,"y":8,"color":"#FFFFFF"},{"x":5,"y":8,"color":"#FFFFFF"},{"x":6,"y":8,"color":"#FFFFFF"},{"x":7,"y":8,"color":"#FFFFFF"},{"x":8,"y":8,"color":"#FFFFFF"},{"x":9,"y":8,"color":"#FFFFFF"},{"x":10,"y":8,"color":"#FFFFFF"},{"x":11,"y":8,"color":"#FFFFFF"},
    {"x":3,"y":9,"color":"#FFFFFF"},{"x":4,"y":9,"color":"#FFFFFF"},{"x":5,"y":9,"color":"#FFFFFF"},{"x":6,"y":9,"color":"#FFFFFF"},{"x":7,"y":9,"color":"#FFFFFF"},{"x":8,"y":9,"color":"#FFFFFF"},{"x":9,"y":9,"color":"#FFFFFF"},{"x":10,"y":9,"color":"#FFFFFF"},{"x":11,"y":9,"color":"#FFFFFF"},{"x":12,"y":9,"color":"#FFFFFF"},
    {"x":3,"y":10,"color":"#FFFFFF"},{"x":4,"y":10,"color":"#FFFFFF"},{"x":5,"y":10,"color":"#FFFFFF"},{"x":6,"y":10,"color":"#FFFFFF"},{"x":7,"y":10,"color":"#FFFFFF"},{"x":8,"y":10,"color":"#FFFFFF"},{"x":9,"y":10,"color":"#FFFFFF"},{"x":10,"y":10,"color":"#FFFFFF"},{"x":11,"y":10,"color":"#FFFFFF"},{"x":12,"y":10,"color":"#FFFFFF"},
    {"x":4,"y":11,"color":"#FFFFFF"},{"x":5,"y":11,"color":"#FFFFFF"},{"x":6,"y":11,"color":"#FFFFFF"},{"x":7,"y":11,"color":"#FFFFFF"},{"x":8,"y":11,"color":"#FFFFFF"},{"x":9,"y":11,"color":"#FFFFFF"},{"x":10,"y":11,"color":"#FFFFFF"},{"x":11,"y":11,"color":"#FFFFFF"},
    {"x":5,"y":12,"color":"#FFFFFF"},{"x":6,"y":12,"color":"#FFFFFF"},{"x":7,"y":12,"color":"#FFFFFF"},{"x":8,"y":12,"color":"#FFFFFF"},{"x":9,"y":12,"color":"#FFFFFF"},{"x":10,"y":12,"color":"#FFFFFF"}
  ]
}
EOF

# Blob - Frame 2 (squishes slightly)
cat > /tmp/blob-2.json << 'EOF'
{
  "width": 16, "height": 16, "background": "transparent", "pixel_size": 1, "grid_lines": false,
  "pixels": [
    {"x":6,"y":4,"color":"#FFFFFF"},{"x":7,"y":4,"color":"#FFFFFF"},{"x":8,"y":4,"color":"#FFFFFF"},{"x":9,"y":4,"color":"#FFFFFF"},
    {"x":5,"y":5,"color":"#FFFFFF"},{"x":6,"y":5,"color":"#FFFFFF"},{"x":7,"y":5,"color":"#FFFFFF"},{"x":8,"y":5,"color":"#FFFFFF"},{"x":9,"y":5,"color":"#FFFFFF"},{"x":10,"y":5,"color":"#FFFFFF"},
    {"x":4,"y":6,"color":"#FFFFFF"},{"x":5,"y":6,"color":"#FFFFFF"},{"x":6,"y":6,"color":"#FFFFFF"},{"x":9,"y":6,"color":"#FFFFFF"},{"x":10,"y":6,"color":"#FFFFFF"},{"x":11,"y":6,"color":"#FFFFFF"},
    {"x":4,"y":7,"color":"#FFFFFF"},{"x":5,"y":7,"color":"#FFFFFF"},{"x":8,"y":7,"color":"#FFFFFF"},{"x":9,"y":7,"color":"#FFFFFF"},{"x":10,"y":7,"color":"#FFFFFF"},{"x":11,"y":7,"color":"#FFFFFF"},
    {"x":3,"y":8,"color":"#FFFFFF"},{"x":4,"y":8,"color":"#FFFFFF"},{"x":5,"y":8,"color":"#FFFFFF"},{"x":6,"y":8,"color":"#FFFFFF"},{"x":7,"y":8,"color":"#FFFFFF"},{"x":8,"y":8,"color":"#FFFFFF"},{"x":9,"y":8,"color":"#FFFFFF"},{"x":10,"y":8,"color":"#FFFFFF"},{"x":11,"y":8,"color":"#FFFFFF"},{"x":12,"y":8,"color":"#FFFFFF"},
    {"x":3,"y":9,"color":"#FFFFFF"},{"x":4,"y":9,"color":"#FFFFFF"},{"x":5,"y":9,"color":"#FFFFFF"},{"x":6,"y":9,"color":"#FFFFFF"},{"x":7,"y":9,"color":"#FFFFFF"},{"x":8,"y":9,"color":"#FFFFFF"},{"x":9,"y":9,"color":"#FFFFFF"},{"x":10,"y":9,"color":"#FFFFFF"},{"x":11,"y":9,"color":"#FFFFFF"},{"x":12,"y":9,"color":"#FFFFFF"},
    {"x":2,"y":10,"color":"#FFFFFF"},{"x":3,"y":10,"color":"#FFFFFF"},{"x":4,"y":10,"color":"#FFFFFF"},{"x":5,"y":10,"color":"#FFFFFF"},{"x":6,"y":10,"color":"#FFFFFF"},{"x":7,"y":10,"color":"#FFFFFF"},{"x":8,"y":10,"color":"#FFFFFF"},{"x":9,"y":10,"color":"#FFFFFF"},{"x":10,"y":10,"color":"#FFFFFF"},{"x":11,"y":10,"color":"#FFFFFF"},{"x":12,"y":10,"color":"#FFFFFF"},{"x":13,"y":10,"color":"#FFFFFF"},
    {"x":3,"y":11,"color":"#FFFFFF"},{"x":4,"y":11,"color":"#FFFFFF"},{"x":5,"y":11,"color":"#FFFFFF"},{"x":6,"y":11,"color":"#FFFFFF"},{"x":7,"y":11,"color":"#FFFFFF"},{"x":8,"y":11,"color":"#FFFFFF"},{"x":9,"y":11,"color":"#FFFFFF"},{"x":10,"y":11,"color":"#FFFFFF"},{"x":11,"y":11,"color":"#FFFFFF"},{"x":12,"y":11,"color":"#FFFFFF"},
    {"x":4,"y":12,"color":"#FFFFFF"},{"x":5,"y":12,"color":"#FFFFFF"},{"x":6,"y":12,"color":"#FFFFFF"},{"x":7,"y":12,"color":"#FFFFFF"},{"x":8,"y":12,"color":"#FFFFFF"},{"x":9,"y":12,"color":"#FFFFFF"},{"x":10,"y":12,"color":"#FFFFFF"},{"x":11,"y":12,"color":"#FFFFFF"}
  ]
}
EOF

# Render all
for name in ghost cat skull blob; do
  python3 "$RENDER" /tmp/${name}-1.json -o "$OUT/${name}-1.png" -p 1 --no-grid-lines
  python3 "$RENDER" /tmp/${name}-2.json -o "$OUT/${name}-2.png" -p 1 --no-grid-lines
  echo "Created ${name}"
done

echo "Done! 1-bit creatures in $OUT"
