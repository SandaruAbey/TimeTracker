import openpyxl

excel_path = "c:\\AI\\TimeTracker\\DAILY Tasking Status Report ( 2026_05_25 - 2026_05_29 ).xlsx"
wb = openpyxl.load_workbook(excel_path)
for name in wb.sheetnames:
    ws = wb[name]
    print(f"\nSheet: {name}")
    print("Data Validations:")
    for dv in ws.data_validations.dataValidation:
        print(f"Formula: {dv.formula1}, Ranges: {dv.sqref}")
