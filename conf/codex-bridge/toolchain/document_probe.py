"""Disposable readiness probe. No business templates, network, or user data."""
from pathlib import Path
from docx import Document
from openpyxl import Workbook, load_workbook
from pptx import Presentation

root = Path('/workspace')
doc = Document()
doc.add_paragraph('文档能力核验')
doc.save(root / 'probe.docx')
assert Document(root / 'probe.docx').paragraphs[0].text == '文档能力核验'
book = Workbook()
book.active.append(['数量', '单价', '总额'])
book.active.append([12, 18, '=A2*B2'])
book.save(root / 'probe.xlsx')
opened = load_workbook(root / 'probe.xlsx', data_only=False)
assert opened.active['A2'].value == 12 and opened.active['C2'].value == '=A2*B2'
opened.close()
slides = Presentation()
slide = slides.slides.add_slide(slides.slide_layouts[1])
slide.shapes.title.text = '演示文稿能力核验'
slide.placeholders[1].text = '保留中文与页面结构'
slides.save(root / 'probe.pptx')
opened_slides = Presentation(root / 'probe.pptx')
assert len(opened_slides.slides) == 1
assert opened_slides.slides[0].shapes.title.text == '演示文稿能力核验'
assert opened_slides.slides[0].placeholders[1].text == '保留中文与页面结构'
print('native-documents-ready')
