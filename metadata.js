/* PULSAR RM — metadata.js
   Lee título, artista, álbum, año, portada y letra incrustados en el archivo de audio.
   Formatos: MP3 (ID3v2.2 / 2.3 / 2.4 y ID3v1), FLAC y M4A / MP4 / AAC.

   Uso:
     const info = await Meta.read(file);   // nunca lanza error
     info = { title, artist, album, year, lyrics, cover }
     cover = { blob, mime } o null

   Solo lee la parte del archivo donde están las etiquetas (no carga el audio completo). */

"use strict";

const Meta = {
  MAX_TAG: 25 * 1024 * 1024, // límite de seguridad para una etiqueta (portadas grandes incluidas)

  async read(file) {
    const result = { title: "", artist: "", album: "", year: "", lyrics: "", cover: null };
    let info = {};
    let usesV1 = false;

    try {
      const head = await this.bytes(file, 0, 12);
      if (this.ascii(head, 0, 3) === "ID3") info = await this.readID3(file);
      else if (this.ascii(head, 0, 4) === "fLaC") info = await this.readFLAC(file);
      else if (this.ascii(head, 4, 4) === "ftyp") info = await this.readMP4(file);
      else usesV1 = true;

      if (!info.title && !info.artist && (usesV1 || this.ascii(head, 0, 3) === "ID3")) {
        info = { ...(await this.readID3v1(file)), ...this.defined(info) };
      }
    } catch (error) {
      console.warn("Pulsar RM: no se pudieron leer los metadatos de", file && file.name, error);
    }

    Object.assign(result, this.defined(info));

    // Si el archivo no trae título, se deduce del nombre ("Artista - Título.mp3")
    if (!result.title) {
      const guess = this.fromFilename((file && file.name) || "");
      result.title = guess.title || "Sin título";
      if (!result.artist && guess.artist) result.artist = guess.artist;
    }
    return result;
  },

  /* ---------- Utilidades ---------- */

  defined(object) {
    const out = {};
    Object.keys(object || {}).forEach((key) => {
      if (object[key] !== undefined && object[key] !== null && object[key] !== "") out[key] = object[key];
    });
    return out;
  },

  async bytes(file, start, length) {
    const end = Math.min(file.size, start + length);
    if (end <= start) return new Uint8Array(0);
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  },

  ascii(b, offset, length) {
    let text = "";
    for (let i = offset; i < offset + length && i < b.length; i++) text += String.fromCharCode(b[i]);
    return text;
  },

  u24(b, o) { return (b[o] << 16) | (b[o + 1] << 8) | b[o + 2]; },
  u32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; },
  u32le(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; },
  synchsafe(b, o) {
    return ((b[o] & 0x7F) << 21) | ((b[o + 1] & 0x7F) << 14) | ((b[o + 2] & 0x7F) << 7) | (b[o + 3] & 0x7F);
  },

  utf8(b) {
    return new TextDecoder("utf-8").decode(b);
  },

  // Codificaciones de ID3: 0 = ISO-8859-1, 1 = UTF-16 con BOM, 2 = UTF-16BE, 3 = UTF-8
  decode(b, enc) {
    if (enc === 3) return this.utf8(b).replace(/^\uFEFF/, "");
    if (enc === 1 || enc === 2) {
      let big = enc === 2;
      let start = 0;
      if (b[0] === 0xFF && b[1] === 0xFE) { big = false; start = 2; }
      else if (b[0] === 0xFE && b[1] === 0xFF) { big = true; start = 2; }
      let text = "";
      for (let i = start; i + 1 < b.length; i += 2) {
        text += String.fromCharCode(big ? (b[i] << 8) | b[i + 1] : (b[i + 1] << 8) | b[i]);
      }
      return text;
    }
    try { return new TextDecoder("windows-1252").decode(b); } catch (error) { return this.ascii(b, 0, b.length); }
  },

  // Texto de un frame: varios valores separados por nulo se unen con coma
  cleanText(text) {
    return text.split("\u0000").map((part) => part.trim()).filter(Boolean).join(", ");
  },

  endOfString(b, start, enc) {
    if (enc === 1 || enc === 2) {
      for (let i = start; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
      return b.length;
    }
    for (let i = start; i < b.length; i++) if (b[i] === 0) return i;
    return b.length;
  },

  termLen(enc) { return enc === 1 || enc === 2 ? 2 : 1; },

  sniffImage(b) {
    if (b[0] === 0xFF && b[1] === 0xD8) return "image/jpeg";
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return "image/png";
    if (this.ascii(b, 0, 3) === "GIF") return "image/gif";
    if (this.ascii(b, 0, 4) === "RIFF" && this.ascii(b, 8, 4) === "WEBP") return "image/webp";
    if (b[0] === 0x42 && b[1] === 0x4D) return "image/bmp";
    return "";
  },

  makeCover(data, mimeHint) {
    if (!data || data.length < 8) return null;
    const mime = this.sniffImage(data) || (/^image\//.test(mimeHint || "") ? mimeHint : "image/jpeg");
    return { blob: new Blob([data], { type: mime }), mime };
  },

  yearOf(text) {
    const match = String(text || "").match(/\d{4}/);
    return match ? match[0] : "";
  },

  fromFilename(name) {
    const base = String(name).replace(/\.[^/.]+$/, "").replace(/_/g, " ").trim();
    const match = base.match(/^(.+?)\s+-\s+(.+)$/);
    if (!match) return { title: base };
    if (/^\d{1,3}$/.test(match[1].trim())) return { title: match[2].trim() }; // "01 - Canción"
    return { artist: match[1].trim(), title: match[2].trim() };
  },

  /* =========================================================
     MP3 — ID3v2
     ========================================================= */

  async readID3(file) {
    const header = await this.bytes(file, 0, 10);
    const major = header[3];
    const flags = header[5];
    const size = this.synchsafe(header, 6);
    if (major < 2 || major > 4 || size <= 0 || size > this.MAX_TAG) return {};

    let body = await this.bytes(file, 10, size);
    if ((flags & 0x80) && major < 4) body = this.unsync(body);

    let pos = 0;
    if ((flags & 0x40) && major >= 3 && body.length > 4) { // cabecera extendida: se salta
      pos = major === 4 ? this.synchsafe(body, 0) : this.u32(body, 0) + 4;
    }

    const idLength = major === 2 ? 3 : 4;
    const headLength = major === 2 ? 6 : 10;
    const TEXT = {
      TIT2: "title", TT2: "title",
      TPE1: "artist", TP1: "artist",
      TALB: "album", TAL: "album",
      TDRC: "year", TYER: "year", TYE: "year", TDRL: "year",
      TPE2: "albumArtist", TP2: "albumArtist"
    };

    const info = {};
    let picture = null;

    while (pos + headLength <= body.length) {
      if (body[pos] === 0) break; // relleno
      const id = this.ascii(body, pos, idLength);
      const frameSize = major === 2 ? this.u24(body, pos + 3)
        : major === 3 ? this.u32(body, pos + 4)
        : this.synchsafe(body, pos + 4);
      const frameFlags = major >= 3 ? (body[pos + 8] << 8) | body[pos + 9] : 0;
      const start = pos + headLength;
      const end = start + frameSize;
      if (frameSize <= 0 || end > body.length) break;
      let data = body.subarray(start, end);
      pos = end;

      // Marcas de formato del frame
      if (major === 4) {
        if (frameFlags & 0x000C) continue;          // comprimido o cifrado: se ignora
        if (frameFlags & 0x0002) data = this.unsync(data);
        if (frameFlags & 0x0040) data = data.subarray(1); // byte de agrupación
        if (frameFlags & 0x0001) data = data.subarray(4); // indicador de longitud
      } else if (major === 3) {
        if (frameFlags & 0x00C0) continue;          // comprimido o cifrado
        if (frameFlags & 0x0020) data = data.subarray(1);
      }
      if (!data.length) continue;

      if (TEXT[id]) {
        const key = TEXT[id];
        if (!info[key]) {
          const value = this.cleanText(this.decode(data.subarray(1), data[0]));
          if (value) info[key] = key === "year" ? this.yearOf(value) : value;
        }
      } else if (id === "APIC" || id === "PIC") {
        const found = this.parseAPIC(data, major === 2);
        if (found && (!picture || found.type === 3)) picture = found; // prefiere "portada frontal"
      } else if ((id === "USLT" || id === "ULT") && !info.lyrics && data.length > 5) {
        const enc = data[0];
        let p = 4; // codificación + idioma (3)
        p = this.endOfString(data, p, enc) + this.termLen(enc);
        const text = this.decode(data.subarray(p), enc).replace(/\u0000+$/, "").trim();
        if (text) info.lyrics = text;
      }
    }

    if (!info.artist && info.albumArtist) info.artist = info.albumArtist;
    delete info.albumArtist;
    if (picture) info.cover = this.makeCover(picture.data, picture.mime);
    return info;
  },

  parseAPIC(data, isV22) {
    if (data.length < 8) return null;
    const enc = data[0];
    let p = 1;
    let mime;
    if (isV22) {
      mime = "image/" + this.ascii(data, 1, 3).toLowerCase().replace("jpg", "jpeg");
      p = 4;
    } else {
      const e = this.endOfString(data, p, 0);
      mime = this.ascii(data, p, e - p).toLowerCase().replace("image/jpg", "image/jpeg");
      p = e + 1;
    }
    const type = data[p];
    p += 1;
    p = this.endOfString(data, p, enc) + this.termLen(enc);
    const image = data.subarray(p);
    return image.length ? { type, mime, data: image } : null;
  },

  // Deshace la "desincronización" de ID3: 0xFF 0x00 vuelve a ser 0xFF
  unsync(b) {
    const out = new Uint8Array(b.length);
    let n = 0;
    for (let i = 0; i < b.length; i++) {
      out[n++] = b[i];
      if (b[i] === 0xFF && b[i + 1] === 0x00) i++;
    }
    return out.subarray(0, n);
  },

  /* ---------- MP3 — ID3v1 (etiqueta antigua de 128 bytes al final) ---------- */

  async readID3v1(file) {
    if (file.size < 128) return {};
    const b = await this.bytes(file, file.size - 128, 128);
    if (this.ascii(b, 0, 3) !== "TAG") return {};
    const field = (from, to) => this.decode(b.subarray(from, to), 0).replace(/\u0000.*$/, "").trim();
    return {
      title: field(3, 33),
      artist: field(33, 63),
      album: field(63, 93),
      year: this.yearOf(field(93, 97))
    };
  },

  /* =========================================================
     FLAC — comentarios Vorbis + imagen
     ========================================================= */

  async readFLAC(file) {
    const info = {};
    let picture = null;
    let pos = 4;

    for (let guard = 0; guard < 200; guard++) {
      const h = await this.bytes(file, pos, 4);
      if (h.length < 4) break;
      const isLast = (h[0] & 0x80) !== 0;
      const type = h[0] & 0x7F;
      const length = this.u24(h, 1);
      pos += 4;

      if ((type === 4 || type === 6) && length > 0 && length <= this.MAX_TAG) {
        const body = await this.bytes(file, pos, length);
        if (type === 4) this.parseVorbis(body, info);
        else {
          const found = this.parseFlacPicture(body);
          if (found && (!picture || found.type === 3)) picture = found;
        }
      }
      pos += length;
      if (isLast) break;
    }

    if (picture) info.cover = this.makeCover(picture.data, picture.mime);
    return info;
  },

  parseVorbis(b, info) {
    let p = 0;
    if (b.length < 8) return;
    p += 4 + this.u32le(b, p);               // fabricante
    if (p + 4 > b.length) return;
    const count = this.u32le(b, p);
    p += 4;
    for (let i = 0; i < count && p + 4 <= b.length; i++) {
      const length = this.u32le(b, p);
      p += 4;
      if (p + length > b.length) break;
      const entry = this.utf8(b.subarray(p, p + length));
      p += length;
      const eq = entry.indexOf("=");
      if (eq < 1) continue;
      const key = entry.slice(0, eq).toUpperCase();
      const value = entry.slice(eq + 1).trim();
      if (!value) continue;
      if (key === "TITLE" && !info.title) info.title = value;
      else if (key === "ARTIST" && !info.artist) info.artist = value;
      else if (key === "ALBUM" && !info.album) info.album = value;
      else if ((key === "DATE" || key === "YEAR") && !info.year) info.year = this.yearOf(value);
      else if ((key === "LYRICS" || key === "UNSYNCEDLYRICS") && !info.lyrics) info.lyrics = value;
    }
  },

  parseFlacPicture(b) {
    if (b.length < 32) return null;
    const type = this.u32(b, 0);
    const mimeLength = this.u32(b, 4);
    let p = 8;
    const mime = this.ascii(b, p, mimeLength).toLowerCase();
    p += mimeLength;
    p += 4 + this.u32(b, p);                 // descripción
    p += 16;                                 // ancho, alto, profundidad, colores
    const length = this.u32(b, p);
    p += 4;
    const data = b.subarray(p, p + length);
    return data.length ? { type, mime, data } : null;
  },

  /* =========================================================
     M4A / MP4 / AAC — átomos (moov > udta > meta > ilst)
     ========================================================= */

  atomHeader(h, available) {
    let size = this.u32(h, 0);
    let head = 8;
    const type = this.ascii(h, 4, 4);
    if (size === 1) { size = this.u32(h, 8) * 4294967296 + this.u32(h, 12); head = 16; }
    else if (size === 0) size = available;
    return { type, size, head };
  },

  // Recorre los átomos de un rango del archivo leyendo solo sus cabeceras
  async atoms(file, start, end) {
    const list = [];
    let pos = start;
    for (let guard = 0; guard < 20000 && pos + 8 <= end; guard++) {
      const h = await this.bytes(file, pos, 16);
      if (h.length < 8) break;
      const { type, size, head } = this.atomHeader(h, end - pos);
      if (size < head) break;
      list.push({ type, start: pos + head, end: Math.min(pos + size, end) });
      pos += size;
    }
    return list;
  },

  // Igual, pero sobre datos que ya están en memoria
  atomsIn(b, start, end) {
    const list = [];
    let pos = start;
    for (let guard = 0; guard < 20000 && pos + 8 <= end; guard++) {
      const { type, size, head } = this.atomHeader(b.subarray(pos, pos + 16), end - pos);
      if (size < head) break;
      list.push({ type, start: pos + head, end: Math.min(pos + size, end) });
      pos += size;
    }
    return list;
  },

  async readMP4(file) {
    const find = (list, type) => list.find((atom) => atom.type === type);
    const moov = find(await this.atoms(file, 0, file.size), "moov");
    if (!moov) return {};
    const udta = find(await this.atoms(file, moov.start, moov.end), "udta");
    if (!udta) return {};
    const meta = find(await this.atoms(file, udta.start, udta.end), "meta");
    if (!meta) return {};
    const ilst = find(await this.atoms(file, meta.start + 4, meta.end), "ilst"); // "meta" trae 4 bytes de versión
    if (!ilst || ilst.end - ilst.start > this.MAX_TAG) return {};

    const b = await this.bytes(file, ilst.start, ilst.end - ilst.start);
    const info = {};
    let albumArtist = "";

    this.atomsIn(b, 0, b.length).forEach((item) => {
      const dataAtom = this.atomsIn(b, item.start, item.end).find((atom) => atom.type === "data");
      if (!dataAtom || dataAtom.end - dataAtom.start <= 8) return;
      const payload = b.subarray(dataAtom.start + 8, dataAtom.end); // 4 de tipo + 4 de idioma
      const text = () => this.utf8(payload).replace(/\u0000+$/, "").trim();

      switch (item.type) {
        case "\u00A9nam": info.title = text(); break;
        case "\u00A9ART": info.artist = text(); break;
        case "aART": albumArtist = text(); break;
        case "\u00A9alb": info.album = text(); break;
        case "\u00A9day": info.year = this.yearOf(text()); break;
        case "\u00A9lyr": info.lyrics = text(); break;
        case "covr": info.cover = this.makeCover(payload, ""); break;
        default: break;
      }
    });

    if (!info.artist && albumArtist) info.artist = albumArtist;
    return info;
  }
};

if (typeof module !== "undefined" && module.exports) module.exports = Meta;
