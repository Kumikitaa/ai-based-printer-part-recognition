# ai-based-printer-part-recognition
## Project Structure
```text
ai-based-printer-part-recognition/
├── data/
│   ├── raw/                  # Original collected printer-part images and annotations
│   ├── processed/            # Cleaned, resized, or split dataset files
│   └── README.md             # Dataset source, class names, and preparation instructions
├── scripts/
│   ├── data_preparation/     # Scripts for cleaning, labeling, and splitting the dataset
│   ├── training/             # Scripts for training and evaluating AI models
│   ├── inference/            # Scripts for predicting a printer part from an image
│   └── utils/                # Shared helper functions, e.g., image processing
├── models/
│   └── *.pt                  # Trained YOLO model-weight files
├── configs/
│   └── *.yaml                # Model settings, paths, classes, and training parameters
├── notebooks/
│   └── *.ipynb               # Exploratory analysis and experiments in Jupyter Notebook
├── tests/
│   └── test_*.py             # Tests for project scripts and functions
├── outputs/
│   ├── metrics/              # Evaluation results, such as accuracy and confusion matrices
│   └── predictions/          # Predicted labels and annotated output images
├── requirements.txt
└── README.md
