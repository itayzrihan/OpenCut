# DBS-TIGER browser model

PoCut's ONNX conversion of [DBS-TIGER-DnR](https://huggingface.co/JusperLee/DBS-TIGER-DnR/tree/22da7d4cd3ea63f9365181008bff1c0d2ab6fb2b), from the [official DBS code](https://github.com/JusperLee/Dynamic-Band-Splitting/tree/ff526463a58ee0278e7bd05c4b8bce112b743e34) by Bingzhe Zhang, Kai Li and Xiaolin Hu. Distributed under the Apache-2.0 license. The conversion exports the same learned weights with real-valued spectral inputs and outputs. The audio never enters the model asset request.

To reproduce the conversion, use the environment created by `classic/apps/web/scripts/dbs-tiger.py setup`, install `onnx==1.17.0` there, and run `classic/apps/web/scripts/export-dbs-tiger-browser.py PATH_TO_OUTPUT`.
