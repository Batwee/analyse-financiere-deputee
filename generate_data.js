const fs = require('fs');
const https = require('https');
const { XMLParser } = require('fast-xml-parser');

const XML_URL = 'https://www.hatvp.fr/livraison/merge/declarations.xml';
const OUTPUT_FILE = 'hatvp_data.json';

function downloadXML(url) {
  return new Promise((resolve, reject) => {
    console.log('Téléchargement du fichier XML HATVP...');
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', err => reject(err));
  });
}

async function processData() {
  try {
    const xmlText = await downloadXML(XML_URL);
    console.log('Parsing du document XML...');

    const parser = new XMLParser({
      ignoreAttributes: false,
      isArray: (name) => name === 'declaration' || name === 'items'
    });
    
    const parsedObj = parser.parse(xmlText);
    const declarations = parsedObj?.declarations?.declaration || [];
    
    const records = [];

    for (const decla of declarations) {
      // Filtrer uniquement les députés
      const qualite = decla?.qualiteMandat?.typeMandat || '';
      const titre = decla?.qualiteMandat?.qualiteDeclarantForAffichage || '';
      
      if (!qualite.toLowerCase().includes('depute') && !titre.toLowerCase().includes('député')) {
        continue;
      }

      const prenom = (decla?.declarant?.prenom || '').trim();
      const nom = (decla?.declarant?.nom || '').trim();
      const eluNom = `${prenom} ${nom}`.trim();

      let parti = (decla?.qualiteMandat?.organe?.codeOrgane || '').trim();
      if (!parti) {
        parti = (decla?.qualiteMandat?.labelOrgane || 'Non renseigné').trim();
      }

      // Extraction des participations financières
      const itemsContainer = decla?.participationsFinancieresDto?.items;
      let items = [];
      if (Array.isArray(itemsContainer)) {
        items = itemsContainer.flatMap(i => i.items || i);
      } else if (itemsContainer?.items) {
        items = Array.isArray(itemsContainer.items) ? itemsContainer.items : [itemsContainer.items];
      }

      for (const item of items) {
        const nomSociete = (item?.nomSociete || '').trim().toUpperCase();
        const evaluationStr = String(item?.evaluation || '0').trim();

        if (!nomSociete) continue;

        // Extraction numérique du montant
        const matches = evaluationStr.replace(/\s+/g, '').match(/\d+/);
        const montant = matches ? parseFloat(matches[0]) : 0;

        records.push({
          entreprise: nomSociete,
          elu: eluNom,
          parti: parti,
          montant: montant
        });
      }
    }

    console.log(`Extraction terminée : ${records.length} lignes trouvées.`);
    
    // Sauvegarde en JSON
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(records, null, 2), 'utf-8');
    console.log(`Fichier JSON généré avec succès : ${OUTPUT_FILE}`);

  } catch (error) {
    console.error('Erreur lors du traitement :', error);
  }
}

processData();