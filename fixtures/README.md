# 原创 PDF 测试样本

<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->

这些样本的文字、矢量图形、PDF 对象、注释和书签由 Jerrivell PDF 项目独立编写，采用 `MIT OR Apache-2.0`。生成器 `tools/generate-fixtures.py` 是可修改源形式，只使用 Python 3.10+ 标准库。没有第三方 PDF、嵌入字体文件、图片、JavaScript、附件或真实个人信息。

```powershell
python tools/generate-fixtures.py
python tools/generate-fixtures.py --check
```

生成结果确定且可重复；`--check` 比较现有文件与生成器输出，不修改文件。`manifest.json` 记录 SHA-256 和预期几何信息，便于发现意外改变。

| 文件 | 预期 |
| --- | --- |
| sample.pdf | 3 页，MediaBox 依次为 595×842、842×595、420×595；第三页 `/Rotate 90` |
| second.pdf | 2 页，均为 612×792 Letter；唯一页面标记 MERGE-ONE、MERGE-TWO |

sample 的 `aurora` 恰好出现 3 次，每页一次；second 的 `horizon` 恰好出现 2 次，每页一次。匹配均为英文 ASCII 小写，便于隔离搜索逻辑与字体映射问题。

sample 第一页含一个 Text note 批注及自定义外观，第二页含一个返回第一页的内部 Link；样本分别有 3 个和 2 个书签。第三页同时具有页面旋转标志与内容变换，因此初始显示保持横向文字正常朝向；不要仅看外观就认定该页 `/Rotate` 为 0。

## 建议操作序列

1. 打开 sample，确认 3 页均可见，第三页显示尺寸为横向。
2. 查找 aurora，确认有 3 个匹配。
3. 将第三页移至最前并撤销，确认 PAGE-ONE、PAGE-TWO、PAGE-THREE 顺序恢复。
4. 旋转第一页、撤销；删除第二页、撤销。
5. 附加 second，确认最终 5 页及两个 MERGE 标记的顺序。
6. 另存新文件并重新打开，确认页数、文字与旋转。
7. 检查 note、内部链接和书签是否保留。若产品尚未支持，应记录为已知限制，不能忽略。
8. 导出 PNG，确认导出的是选择页且方向与视图一致。

这些样本不覆盖 CJK/中文字体、图片扫描、OCR、加密、表单、数字签名、PDF/A、PDF/UA、损坏输入、大文件或安全边界。后续语料必须另外取得使用与再分发授权。
