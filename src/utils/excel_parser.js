import XLSX from 'xlsx';

export function parseProducts(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(worksheet);

  return data.map(item => ({
    type: item['구분'], // '자동차' or '오토바이'
    brand: item['브랜드'],
    model: item['모델명'],
    year: item['연식/세대'],
    bsa: item['BSA유무'], // 'Y' or 'N'
    price: item['판매가'],
    detailType: item['상세설명타입'],
    detailContent: item['상세설명내용'],
    mainImage: item['대표이미지경로']
  }));
}
