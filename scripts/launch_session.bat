chcp 65001
call "%~1\env.bat"
set /p ARGS=<"%~1\args.txt"
claude %ARGS%
