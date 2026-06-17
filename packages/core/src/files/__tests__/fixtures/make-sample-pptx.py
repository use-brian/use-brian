#!/usr/bin/env python3
"""Generate the minimal sample.pptx fixture used by parsers.test.ts.

A .pptx is a ZIP of Office Open XML parts. We hand-author the parts the text
extractor reads: the presentation (slide order via sldIdLst), the package rels
(rId -> slide path), two slides, and one notes slide. No PowerPoint or
python-pptx needed.

Run from the fixtures dir:  python3 make-sample-pptx.py
"""
import zipfile

A = "http://schemas.openxmlformats.org/drawingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"

CONTENT_TYPES = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="{CT}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>
</Types>"""

ROOT_RELS = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="{PKG}">
  <Relationship Id="rId1" Type="{R}/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>"""

# sldIdLst defines display order: rId2 (slide1) then rId3 (slide2).
PRESENTATION = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="{A}" xmlns:r="{R}" xmlns:p="{P}">
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId2"/>
    <p:sldId id="257" r:id="rId3"/>
  </p:sldIdLst>
</p:presentation>"""

PRESENTATION_RELS = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="{PKG}">
  <Relationship Id="rId2" Type="{R}/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId3" Type="{R}/slide" Target="slides/slide2.xml"/>
</Relationships>"""

def slide(paragraphs):
    body = "".join(
        f"<p:sp><p:txBody>{''.join(f'<a:p><a:r><a:t>{t}</a:t></a:r></a:p>' for t in para)}</p:txBody></p:sp>"
        for para in paragraphs
    )
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="{A}" xmlns:r="{R}" xmlns:p="{P}"><p:cSld><p:spTree>{body}</p:spTree></p:cSld></p:sld>"""

SLIDE1 = slide([["Market Analysis"], ["Q2 revenue up 40%."]])
SLIDE2 = slide([["Next Steps"], ["Hire two AEs."]])

SLIDE1_RELS = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="{PKG}">
  <Relationship Id="rId1" Type="{R}/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
</Relationships>"""

NOTES1 = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="{A}" xmlns:r="{R}" xmlns:p="{P}"><p:cSld><p:spTree>
  <p:sp><p:txBody><a:p><a:r><a:t>Emphasize the EU segment.</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:notes>"""

with zipfile.ZipFile("sample.pptx", "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", CONTENT_TYPES)
    z.writestr("_rels/.rels", ROOT_RELS)
    z.writestr("ppt/presentation.xml", PRESENTATION)
    z.writestr("ppt/_rels/presentation.xml.rels", PRESENTATION_RELS)
    z.writestr("ppt/slides/slide1.xml", SLIDE1)
    z.writestr("ppt/slides/slide2.xml", SLIDE2)
    z.writestr("ppt/slides/_rels/slide1.xml.rels", SLIDE1_RELS)
    z.writestr("ppt/notesSlides/notesSlide1.xml", NOTES1)

print("wrote sample.pptx")
