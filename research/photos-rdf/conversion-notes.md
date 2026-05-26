
## CSV columns
 Data-hora,eH,PH,BP,S,BT,Nome,Categoria,Chamada?,Bonde?,Chuva?,🗺️,📝,🎨,Post IG,Rota,Ativ. Strava,Ativ. RWGPS,Horário,Partida,Chegada,# presentes,# novos,# strava,kJ anunc.,kJ med.,% Mov,Tempo Total,Tempo Mov,Potência Média,Quilojaules Ag. Total,litros gasolina ag total,Tempo Ag. Total,Tempo Ag. Mov,#midias,Descrito no Doc,Fotos Coletadas,Presenças

## CSV to ttl heuristics

- Data-hora -> dcterms:date
- Nome: dcterms:title
- PH=true -> ph:phInSeriesEdition phd:PH
- BP=true -> ph:phInSeriesEdition phd:BP
- PH-S=true -> ph:phInSeriesEdition phd:S
- BT=true -> ph:phInSeriesEdition phd:BT
- PostIG -> ph.linkInstagram
- Rota -> ph.linkRWGPS
- #presentes -> ph:countAttendee
- #novos -> ph.countNewcomer
- kJ anounc. -> ph.EnergyEstimate
- 🗺️,📝,🎨 -> ph.wasAttributedTo
  