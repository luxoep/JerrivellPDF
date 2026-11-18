// SPDX-License-Identifier: MIT OR Apache-2.0
// Original geometric test drawings; no customer artwork or font programs.
export function drawing({changed=false,shift=0,rotation=0,width=1191,height=842,crop=false}={}){
  const circle=(x,y,r)=>`${x+r} ${y} m ${x+r} ${y+r*.5523} ${x+r*.5523} ${y+r} ${x} ${y+r} c ${x-r*.5523} ${y+r} ${x-r} ${y+r*.5523} ${x-r} ${y} c ${x-r} ${y-r*.5523} ${x-r*.5523} ${y-r} ${x} ${y-r} c ${x+r*.5523} ${y-r} ${x+r} ${y-r*.5523} ${x+r} ${y} c S`;
  let stream=`q 1 0 0 1 ${shift} 0 cm 0 0 0 RG 0 g .5 w 25 25 ${width-50} ${height-50} re S 70 150 600 400 re S `;
  for(let row=0;row<3;row++)for(let col=0;col<5;col++)stream+=circle(130+col*105+(changed&&row===1&&col===2?3:0),220+row*110,18)+'\n';
  stream+=`BT /F1 18 Tf 70 730 Td (JERRIVELL ORIGINAL MECHANICAL TEST) Tj ET BT /F1 14 Tf 75 660 Td (${changed?'M10 +0.20':'M8 +0.02'}) Tj ET `;
  stream+=`0.3 w 80 570 m 650 570 l S 80 565 m 80 580 l S 650 565 m 650 580 l S `;
  if(changed)stream+='0 g 245.7 596.1 .28 .28 re f 0 0.4 0 RG 800 350 m 960 400 l S ';
  stream+='Q';return pdfObjects(stream,width,height,rotation,crop);
}
export function pdfObjects(stream,width=600,height=800,rotation=0,crop=false){
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ${crop?`/CropBox [20 10 ${width-20} ${height-10}]`:''} /Rotate ${rotation} /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  return serializeObjects(objects);
}
export function serializeObjects(objects){
  let text='%PDF-1.7\n';const offsets=[0];objects.forEach((value,index)=>{offsets.push(Buffer.byteLength(text));text+=`${index+1} 0 obj\n${value}\nendobj\n`});const xref=Buffer.byteLength(text);text+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n`;for(const offset of offsets.slice(1))text+=`${String(offset).padStart(10,'0')} 00000 n \n`;text+=`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(text);
}
export function rasterDrawing(changed=false){
  const width=256,height=192,pixels=Buffer.alloc(width*height*3,255);
  const black=(x,y)=>{for(let c=0;c<3;c++)pixels[(y*width+x)*3+c]=0};
  for(let x=12;x<244;x++)for(const y of [12,145,178])black(x,y);
  for(let y=12;y<=178;y++)for(const x of [12,243])black(x,y);
  for(let y=40;y<125;y++)for(let x=40;x<215;x++){const d=Math.hypot(x-125,y-82);if(Math.abs(d-35)<.7)black(x,y)}
  if(changed){for(let y=50;y<58;y++)for(let x=165;x<177;x++)black(x,y);black(225,32)}
  const stream='q 600 0 0 450 0 0 cm /Im1 Do Q',hex=pixels.toString('hex')+'>';
  return serializeObjects(['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 450] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${hex.length} >>\nstream\n${hex}\nendstream`]);
}
export function formDrawing(changed=false){
  const appearance=`1 1 1 rg 0 0 160 40 re f 0 0 0 rg BT /F1 18 Tf 10 12 Td (${changed?'M10 +0.20':'M8 +0.02'}) Tj ET`;
  return serializeObjects(['<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R] /NeedAppearances false >> >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 450] /Resources << >> /Contents 4 0 R /Annots [6 0 R] >>','<< /Length 0 >>\nstream\n\nendstream','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Type /Annot /Subtype /Widget /FT /Tx /T (Dimension) /V (${changed?'M10':'M8'}) /Rect [50 300 210 340] /F 4 /P 3 0 R /AP << /N 7 0 R >> >>`,`<< /Type /XObject /Subtype /Form /BBox [0 0 160 40] /Resources << /Font << /F1 5 0 R >> >> /Length ${appearance.length} >>\nstream\n${appearance}\nendstream`]);
}
