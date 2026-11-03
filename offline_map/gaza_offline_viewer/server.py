"""Run from any folder: python gaza_offline_viewer/server.py (offline, no dependencies)."""
import sqlite3,os,re,mimetypes
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
ROOT=Path(__file__).resolve().parent
DB=ROOT.parent/'gaza_copernicus_osm_z11-z17.mbtiles'
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  m=re.fullmatch(r'/tiles/(1[1-7])/(\d+)/(\d+)\.webp',self.path)
  if m:
   z,x,y=map(int,m.groups())
   with sqlite3.connect(DB) as db:result=db.execute('SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?',(z,x,(1<<z)-1-y)).fetchone()
   if not result:return self.send_error(404)
   data=result[0];typ='image/webp'
  else:
   name=self.path.lstrip('/') or 'index.html'
   if name not in ('index.html','leaflet.js','leaflet.css'):return self.send_error(404)
   data=(ROOT/name).read_bytes();typ=mimetypes.guess_type(name)[0] or 'text/html'
  self.send_response(200);self.send_header('Content-Type',typ);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
if __name__=='__main__':
 print('Open http://localhost:8765 — the viewer does not need internet access',flush=True)
 ThreadingHTTPServer(('0.0.0.0',8765),Handler).serve_forever()
