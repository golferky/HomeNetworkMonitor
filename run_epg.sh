#!/bin/bash

echo "----- Updating code from GitHub -----"
cd ~/epg/source/epgmanager || exit

git pull

echo ""
echo "----- Cleaning old build -----"
rm -rf bin obj

echo ""
echo "----- Building project -----"
dotnet build

echo ""
echo "----- Running EPG Manager -----"
dotnet run

