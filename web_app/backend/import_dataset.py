import pandas as pd
from pandas import DataFrame

from database import AsyncSessionLocal, asyncio, engine, text, PrinterPart, PrinterModel, PartCompatibility
from sqlalchemy import func, select

printer_model = "E877"
df = pd.read_excel("./dataset/All_Printer_Components_Information.xlsx", index_col="Part No.", sheet_name=f"{printer_model}")


def validate():
    pass


async def insert_printer_parts(data: DataFrame, model_name: str):
    added = 0
    skipped = 0
    linked = 0

    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(PrinterModel).where(
                PrinterModel.name == model_name
            )
        )
        printer_model = result.scalar_one_or_none()

        if printer_model is None:
            raise ValueError(f"Printer model '{model_name}' does not exist.")

        # Find the highest existing class ID
        last_class_id = await session.scalar(
            select(func.max(PrinterPart.class_id))
        )

        # If catalogue is empty, start from 0
        next_class_id = (
            0 if last_class_id is None else last_class_id + 1
        )

        # Iterate through each row containing one printer part specifications
        for index, specifications in data.iterrows():
            # Retrieve serial part number and description
            serial_number = specifications["Serial Part Number"]
            description = specifications["Part Description"]

            # Find already existing printer parts
            result = await session.execute(
                select(PrinterPart).where(
                    PrinterPart.serial_number == serial_number
                )
            )
            part = result.scalar_one_or_none()

            # If part is inside database - check compatibility
            if part is None:
                new_part = PrinterPart(
                    class_id=next_class_id,
                    serial_number=serial_number,
                    part_desc=description
                )

                session.add(new_part)
                await session.commit()

                next_class_id += 1
                added += 1
            else:
                skipped += 1

            compatibility = await session.get(
                PartCompatibility,
                {
                    "part_id": part.id,
                    "printer_model_id": printer_model.id,
                }
            )

            if compatibility is None:
                session.add(
                    PartCompatibility(
                        part_id = part.id,
                        printer_model_id = printer_model.id,
                    )
                )
                await session.commit()
                linked += 1



        print(f"Insertion completed! {added} parts were added. {skipped} parts were skipped. {linked} compatibility associations added.")


async def insert_printer_models(models: list):
    async with AsyncSessionLocal() as session:
        for model_name in models:
            result = await session.execute(
                select(PrinterModel).where(PrinterModel.name == model_name)
            )
            model = result.scalar_one_or_none()

            if model is None:
                session.add(PrinterModel(name = model_name))
                print(f"{model_name} printer models were added!")


async def main():
    try:
        await insert_printer_models(["E877", "E786", "E731"])
        await insert_printer_parts(df, f"{printer_model}")
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
