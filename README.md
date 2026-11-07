# ai-based-printer-part-recognition


## Project Overview
The AI-based Printer Part Recognition System is a web-based application designed to assist service engineers and general users in identifying printer components from images. The application is accessible through a browser and requires **no local software installation!**\
\
To support main functionality, the system integrates two computer vision approaches: YOLO-based object detection and Vision Transformer (ViT)-based classification. While YOLO provides an established approach for locating objects within images, Vision Transformers introduce attention-based techniques for learning visual features and distinguishing between object classes.\
\
By combining these approaches, the project aims to improve the printer-part classification in images containing multiple components. This hybrid architecture also provides a foundation for future model improvements and the expansion of supported printer-part classes.
## Technical Overview
The system backend is developed in Python using FastAPI, Uvicorn, and SQLAlchemy. It provides the web interface, catalogue APIs, and performs printer-part detection using the P-Vision `best_v26_det.pt` model.
> [!WARNING]
> Current image recognition supports only E877 printer model.

### Technology Stack
| Technology | Responsibility |
|------------|----------------|
| FastAPI    | Defines API endpoints, validates request parameters, and coordinates catalogue queries and recognition requests |
| Uvicorn    | Runs the FastAPI application as an ASGI server |
| SQLAlchemy | Defines database models and performs asynchronous database operations |
| SQLite and aiosqlite | Store catalogue data and provide asynchronous database operations |
| Ultralytics YOLO | Loads the trained detection model and identifies printer parts in uploaded images |
| Pillow | Validates, decodes, and prepares uploaded images for inference |
| pandas | Read printer-part information from Excel worksheets for database import |

### Backend Organization
| Module            | Responsibility    |
|-------------------|-------------------|
| `api.py`            | Creates the FastAPI application, registers API routers, serves frontend files, and manages application startup and shutdown |
| `catalogue_api.py`  | Provides catalogue health checks, printer-model retrieval, printer-part lising |
| `detection_api.py`  | Validates image uploads, runs detection, and matches predictions with catalogue records |
| `database.py`       | Defines database tables, the asynchronous engine, and database sessions |
| `import_dataset.py` | Imports printer-part information and model compatibility records from Excel |
> [!NOTE]
> Some of the details on code execution:
> + The detector is loaded once during application startup
> + Image decoding and model inference run in a thread pool
> + Database queries use asynchronous SQLAlchemy sessions
> + Database connections are disposed during application shutdown

### Database and Catalogue Import
The backend uses a SQLite database at `database/PrinterPartCatalogue.db`. In it, there are three main tables:
| Table                   | Purpose                 |
|-------------------------|-------------------------|
| `printer_models`          | Stores printer-model names |
| `printer_parts`           | Stores catalogue class IDs, part numbers, and descriptions |
| `printer_compatibilities` | Links parts to compatible printer models through a many-to-many association |


There are also two supporting tables, `recognition_logs` and `part_predictions`, designed to store recognition history.

> [!WARNING]
> Current detection endpoint doesn't write results to these tables.

The `import_dataset.py` script reads `dataset/your_dataset.xlsx` file, where each printer model has a separate worksheet containing Part No., Serial Part Number, and Part Description columns. The import workflow first checks for existing parts by serial part number, then assigns sequential catalogue class IDs to new parts, and lastly creates compatibility associations.
> [!NOTE]
> Developers must configure the selected worksheet and printer-model list in the script before execution.

### API Enpoints
The backend includes six API endpoints.
| Method | Endpoint                | Purpose |
|--------|-------------------------| ------- |
| GET    | /api/health             | Checks access to the three catalogue tables |
| GET    | /api/models             | Returns printer-model names stored in the database |
| GET    | /api/catalogue/models   | Returns printer-model IDs, names, and compatible part counts |
| GET    | /api/catalogue/parts    | Returns searchable catalogue entries |
| GET    | /api/recognition/models | Returns models supported by the recognition service |
| POST   | /detect                 | Accepts an image and printer-model selection, runs recognition inference, and returns detected parts and their catalogue information |


## Project Structure
```text
ai-based-printer-part-recognition/
├── configs/
│   └── *.yaml                # Model settings, paths, classes, and training parameters
├── data/
│   ├── raw/                  # Original collected printer-part images and annotations
│   ├── processed/            # Cleaned, resized, or split dataset files
│   └── README.md             # Dataset source, class names, and preparation instructions
├── models/
│   └── *.pt                  # Trained YOLO model-weight files
├── notebooks/
│   └── *.ipynb               # Exploratory analysis and experiments in Jupyter Notebook
├── outputs/
│   ├── metrics/              # Evaluation results, such as accuracy and confusion matrices
│   └── predictions/          # Predicted labels and annotated output images
├── scripts/
│   ├── data_preparation/     # Scripts for cleaning, labeling, and splitting the dataset
│   ├── training/             # Scripts for training and evaluating AI models
│   ├── inference/            # Scripts for predicting a printer part from an image
│   └── utils/                # Shared helper functions, e.g., image processing
├── tests/
│   └── test_*.py             # Tests for project scripts and functions
├── web_app/
│   ├── backend/
│   │   ├── database/
│   │       └── PrinterPartCatalogue.db                       # Database instance
│   │   ├── dataset/
│   │       └── All_Printer_Components_Informations.xlsx      # Excel workbook containing 3 printer models and their component part specifications
│   │   ├── app.py                                            # Application setup, router registration, and frontend serving
│   │   ├── catalogue_api.py                                  # Catalogue queries, search, filtering, and pagination
│   │   ├── database.py                                       # ORM models, database engine, and asynchronous sessions
│   │   ├── detection_api.py                                  # Upload validation, detection inference, and catalogue matching
│   │   ├── import_dataset.py                                 # Excel import and part compatibility association
│   │   └── requirements.txt                                  # Python dependencies
│   ├── frontend
│   │   ├── assets/
│   │       ├── scripts/      # JavaScript files
│   │       ├── static/       # Logos and icons
│   │       └── styles/       # CSS files
│   |   └── index.html        # Main web page
│   └── README.md             # Instructions for starting the frontend and backend
├── requirements.txt
└── README.md
```
