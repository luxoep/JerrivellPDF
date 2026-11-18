# SPDX-License-Identifier: MIT OR Apache-2.0
"""Independent CSV/PNG checks against known original synthetic drawing geometry."""
from pathlib import Path
import csv, io, json, sys
from PIL import Image

root = Path(sys.argv[1]).resolve()
report = json.loads((root/'report-metadata.json').read_text(encoding='utf-8'))
rows = list(csv.reader(io.StringIO((root/'report.csv').read_text(encoding='utf-8-sig'))))
assert len(rows[0]) == 1 and rows[0][0].startswith('# Jerrivell drawing comparison;')
assert 'DPI=150' in rows[0][0] and 'threshold=0' in rows[0][0]
header = rows[1]
regions = [dict(zip(header,row)) for row in rows[2:]]
assert len(regions) == len(report['regions'])
assert sum(int(r['pixels']) for r in regions) == report['changedPixels'] > 0
assert len({int(r['id']) for r in regions}) == len(regions)
assert regions[0]['reviewed'] == 'true' and all(r['reviewed']=='false' for r in regions[1:])
for row in regions:
    assert int(row['added'])+int(row['removed'])+int(row['changed']) == int(row['pixels'])
    assert float(row['width_mm'])>0 and float(row['height_mm'])>0

# Compare reported paper-mm bounds with the independently specified PDF fixture
# coordinates. Pixel tolerances below cover raster rounding, not absent changes.
def intersects(left, top, right, bottom):
    for row in regions:
        x,y,w,h = (float(row[k])*72/25.4 for k in ['x_mm','y_mm','width_mm','height_mm'])
        if x<right+1 and x+w>left-1 and y<bottom+1 and y+h>top-1:
            return True
    return False

expected = {'dimension_text':(73,160,235,187), 'tiny_dot':(245,245,247,247),
            'hole_position':(320,492,364,532), 'added_line':(798,440,963,494)}
for name, bounds in expected.items():
    assert intersects(*bounds), f'Missing controlled geometry: {name}'
assert any(int(r['pixels'])<20 for r in regions), 'Tiny changes were filtered'

image = Image.open(root/'report.png').convert('RGBA')
assert image.width == 2048
paper_height = round(report['heightPt']*2048/report['widthPt'])
assert image.height == paper_height+82, 'Report legend missing or image truncated'
footer = image.crop((0,paper_height,image.width,image.height))
assert sum(1 for r,g,b,a in footer.getdata() if b>r and r<100) > 100, 'No readable report labels'
assert all(image.getpixel((x,image.height-1))==(255,253,246,255) for x in [0,100,image.width-1])
result={'status':'PASS','checks':['CSV metadata and region arithmetic','review status mapping','all four independent controlled geometry locations','tiny point retained','PNG complete paper and readable legend'], 'regions':len(regions),'imageSize':list(image.size)}
print(json.dumps(result,indent=2))
