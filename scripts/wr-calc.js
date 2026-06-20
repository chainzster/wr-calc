// Read query string before we do any binding as it may remove it.
var s = location.search;
var usp = new URLSearchParams(s);

var dateString = usp.get('d');
var fixturesString = usp.get('f');

var sourceString = usp.has('w') ? 'wru' : usp.get('s'); // support ?w for older links
if (!sourceString) {
    sourceString = 'mru';
}

// Create the view model and bind it to the HTML.
var viewModel = new ViewModel(sourceString);
ko.applyBindings(viewModel);

viewModel.saveSeedsAndLoad = function () {
    saveSeedsFromUI(sourceString);
};

viewModel.clearAndReenterSeeds = function () {
    localStorage.removeItem('wr-calc-seeds-' + sourceString);
    viewModel.teams([]);
    viewModel.fixtures([]);
    viewModel.rankingsById(null);
    viewModel.baseRankings(null);
    viewModel.rankingsChoice(null);
    viewModel.seedsRequired(true);
};

// Load rankings from World Rugby.
var loadRankings = function (rankingsSource, startDate, fixtures, event) {
    viewModel.rankingsSource(rankingsSource);
    $.get('https://api.wr-rims-prod.pulselive.com/rugby/v3/rankings/' + rankingsSource + (startDate ? ('?date=' + startDate) : '')).done(function (data) {
        var rankings = {};
        $.each(data.entries, function (i, e) {
            var maxLength = 15;
            e.team.displayName = e.team.name.length > maxLength ? e.team.abbreviation : e.team.name;
            e.team.displayTitle = e.team.name.length > maxLength ? e.team.name : null;

            viewModel.teams.push(e.team);
            rankings[e.team.id] = new RankingViewModel(e);
        });
        viewModel.rankingsById(rankings);

        if (event) {
            // Restrict selectable teams to those in the event
            var eventTeamIds = {};
            $.each(fixtures, function (i, e) {
                if (e.teams[0] && e.teams[0].id != '0') eventTeamIds[e.teams[0].id] = true;
                if (e.teams[1] && e.teams[1].id != '0') eventTeamIds[e.teams[1].id] = true;
            });
            viewModel.teams.remove(function (t) { return !eventTeamIds[t.id]});
        }

        var sorted = [];
        $.each(rankings, function (i, r) {
            sorted.push(r);
        });
        sorted.sort(function (a, b) { return b.pts() - a.pts(); });

        viewModel.baseRankings(sorted);
        viewModel.originalDate(data.effective.label);
        viewModel.originalMillis = data.effective.millis;
        viewModel.rankingsChoice('original');

        // There's a bug with historical MRU rankings where their effective date is set after the requested date (2020-09-21).
        // The effective date should never be in the future by more than a day, so we should be able to detect this and guess a date instead.
        // (It could be a little bit in the future because we ask for midnight but the rankings are published during the day.)
        ////var requestedStartDateMillis = new Date(startDate).getTime();
        ////if (viewModel.originalMillis > requestedStartDateMillis + (24 * 60 * 60 * 1000)) {
        // In fact ignore the millis and just compare the "label" as it's lexicographical and as it's just the date it should never be in the future.
        if (data.effective.label > startDate) {
            viewModel.originalDate(startDate);
            viewModel.originalMillis = new Date(startDate).getTime();
            viewModel.originalDateIsEstimated(true);
        }

        // When we're done, load fixtures in.
        if (fixturesString) {
            viewModel.fixturesString(fixturesString);
            viewModel.rankingsChoice('calculated');
            viewModel.queryString.subscribe(function (qs) {
                history.replaceState(null, '', '?' + qs);
            });
        } else {
            // This should be parallelisable if we have our observables set up properly. (Fixture validity depends on teams.)
            if (fixtures) {
                fixturesLoaded(fixtures, rankings, event);
            } else {
                addFixture();
                loadFixtures(rankings, !!dateString);
            }
        }
    });
};

// Helper to add a fixture to the top/bottom.
// If we had up/down buttons we could maybe get rid of this.
var addFixture = function (top, process) {
    var fixture = new FixtureViewModel(viewModel);
    if (process) {
        process(fixture);
    }

    if (top) {
        viewModel.fixtures.unshift(fixture);
    } else {
        viewModel.fixtures.push(fixture);
    }
}

// Load fixtures from World Rugby.
var loadFixtures = function(rankings, specifiedDate) {
    // Load a week of fixtures from when the rankings are dated.
    // (As that is what will make it into the next rankings.)
    // Or until next monday.
    function nextMonday() {
      var d = new Date();
      d.setDate(d.getDate() + ((7-d.getDay())%7) + 1);
      return d;
    }
    var rankingDate  = new Date(viewModel.originalDate());
    var from = formatDate( rankingDate );
    var toDate = specifiedDate ? rankingDate.addDays(7) : nextMonday();
    var to   =  formatDate( toDate );

    // We load all fixtures and eventually filter by matching teams.
    var url = "https://api.wr-rims-prod.pulselive.com/rugby/v3/match?startDate="+from+"&endDate="+to+"&sort=asc&pageSize=100&page=";
    var getFixtures = function (fixtures, page, then) {
        $.get(url + page).done(function(data) {
            if (data.content.length == 100) {
                getFixtures(fixtures.concat(data.content), page + 1, then);
            } else {
                then(fixtures.concat(data.content), rankings);
            }
        });
    };

    getFixtures([], 0, fixturesLoaded);
}

var fixturesLoaded = function (fixtures, rankings, event) {
    // N.B. since we add to the top, these get reversed, so reverse the order here!
    fixtures.reverse();

    // We make extra AJAX requests for any fixture with a venue in the hope of working out
    // if the home team has advantage.
    // Keep track of those here, so we can check when all queries are finished and subscribe
    // to the query string then.
    var anyQueries = false;
    var venueQueryCount = 0;
    var venueQueries = {};
    function queryVenue(id) {
        var query = venueQueries[id];
        if (!query) {
            query = $.get('https://api.wr-rims-prod.pulselive.com/rugby/v3/team/' + id);
            venueQueries[id] = query;
        }
        return query;
    }

    // Parse each fixture into a view model, which adds it to the array.
    $.each(fixtures, function (i, e) {
        // I don't think we can reliably only request fixtures relevant to loaded teams, so filter here.
        // For knockouts where a team may not be decided yet, allow team to be null or id to be 0
        if ((e.teams[0] && (e.teams[0].id != '0') && !rankings[e.teams[0].id]) || (e.teams[1] && (e.teams[1].id != '0') && !rankings[e.teams[1].id])) {
            return;
        };

        addFixture(true, function (fixture) {
            fixture.homeId(e.teams[0].id);
            if (e.teams[1]) fixture.awayId(e.teams[1].id); // See ANC above
            fixture.noHome(false);
            fixture.switched(false);
            fixture.kickoff = $.formatDateTime('D dd/mm/yy hh:ii', new Date(e.time.millis));

            // Covid-TRC (noticed in 2021 but apparently also in 2020) ignores the stadium location
            // and treats the nominal home team as always at home
            var tournamentRespectsStadiumLocation = !e.events.some(function (event) {
                return event.label.match(/^202[01] Rugby Championship$/);
            });

            if (e.venue) {
                fixture.venueNameAndCountry = [e.venue.name, e.venue.country].join(', ');
                fixture.venueCity = e.venue.city;
                anyQueries = true;
                venueQueryCount++;
                queryVenue(e.teams[0].id).done(function(teamData) {
                    if (e.venue.country !== teamData.country) {
                        if (e.teams[1]) {
                            venueQueryCount++;
                            queryVenue(e.teams[1].id).done(function(teamData) {
                                if (e.venue.country === teamData.country) {
                                    // Saw this in the Pacific Nations Cup 2019 - a team was nominally Away
                                    // but in a home stadium. They seemed to get home nation advantage.
                                    if (tournamentRespectsStadiumLocation) {
                                        fixture.switched(true);
                                    }
                                } else {
                                    if (tournamentRespectsStadiumLocation) {
                                        fixture.noHome(true);
                                    }
                                }
                            }).always(function () {
                                venueQueryCount--;
                                if (venueQueryCount === 0) {
                                    viewModel.queryString.subscribe(function (qs) {
                                        history.replaceState(null, '', '?' + qs);
                                    });
                                }
                            });
                        } else { // See ANC above
                            // Don't know who the second team is, but we do know the first team isn't at home.
                            if (tournamentRespectsStadiumLocation) {
                                fixture.noHome(true);
                            }
                        }
                    }
                }).always(function () {
                    venueQueryCount--;
                    if (venueQueryCount === 0) {
                        viewModel.queryString.subscribe(function (qs) {
                            history.replaceState(null, '', '?' + qs);
                        });
                    }
                });
            }
            fixture.isRwc((event && event.rankingsWeight == 2) || (e.events.length > 0 && e.events[0].rankingsWeight == 2) || (!!e.competition.match(/Rugby World Cup/)));

            if (event) {
                function shortenPhase(name) {
                    return name && name.replace(/[a-z]+-final/, 'F').replace('Runner-up P', '2nd P').replace('Runner-up S', 'Loser S');
                }
                fixture.eventPhase = shortenPhase(e.eventPhase);
                if (e.teams[0].id == '0' && e.teams[0].name) {
                    fixture.homeCaption = shortenPhase(e.teams[0].name);
                }
                if (e.teams[1].id == '0' && e.teams[1].name) {
                    fixture.awayCaption = shortenPhase(e.teams[1].name);
                }
            }

            // If the match isn't unstarted (or doesn't not have live scores), add
            // the live score.
            // U is unstarted / no live score.
            // UP/CC are postponed/cancelled and also have no live score.
            // C is complete.
            // L1/LH/L2 are I believe the codes for 1st half, half time, 2nd half but I forgot.
            if (e.status !== 'U' && e.status !== 'UP' && e.status !== 'CC') {
                fixture.homeScore(e.scores[0]);
                fixture.awayScore(e.scores[1]);
            }
            switch (e.status) {
                case 'U': {
                    // Try to detect if a match should have started by now, and just hasn't been reported by WR.
                    // Give it a bit of leeway.
                    var leeway = 5 * 60 * 1000; // 5 minutes
                    if (e.time.millis + leeway > new Date()) {
                        fixture.liveScoreMode = 'Upcoming';
                    } else {
                        fixture.liveScoreMode = 'Unreported';
                    }
                    break;
                }
                case 'UP': fixture.liveScoreMode = 'Postponed'; break;
                case 'CC': fixture.liveScoreMode = 'Cancelled'; break;
                case 'C': {
                    fixture.liveScoreMode = 'Complete';
                    // WR started publishing rankings on match days during the world cup.
                    // Try to work out if the match is already included in the rankings.
                    // We know it is "complete" because we're in that case.
                    // Try to ensure it ended before the ranking timestamp.
                    // (If we used the start time here we would block events that were in progress when
                    // the rankings were published, which obviously can't have been in the rankings.)
                    // This will incorrectly exclude a match that has completed, if WR published rankings
                    // 90 minutes after it started that didn't include the result.
                    // This will incorrectly include a match that is not marked as complete but is included
                    // in the rankings, or that finished and was included in the rankings less than 90
                    // minutes after it kicked off.
                    var kickoffMillis = e.time.millis;
                    var endMillis = kickoffMillis + 90 * 60 * 1000;
                    if (endMillis < viewModel.originalMillis) {
                        fixture.alreadyInRankings = true;
                    }
                    break;
                }
                case 'L1': fixture.liveScoreMode = 'First half'; break;
                case 'L2': fixture.liveScoreMode = 'Second half'; break;
                case 'LHT': fixture.liveScoreMode = 'Half time'; break;
            }
        });
    });

    if (!anyQueries) {
        viewModel.queryString.subscribe(function (qs) {
            history.replaceState(null, '', '?' + qs);
        });
    }
};

// Format a date for the fixture or rankings API call.
var formatDate = function(date) {
    var d     = new Date(date),
        month = '' + (d.getMonth() < 9 ? '0' : '') + (d.getMonth() + 1),
        day   = '' + (d.getDate() < 10 ? '0' : '') + d.getDate(),
        year  = d.getFullYear();

    return [year, month, day].join('-');
}

// Add days to a date.
Date.prototype.addDays = function (d) {
    if (d) {
        var t = this.getTime();
        t = t + (d * 86400000);
        this.setTime(t);
    }
    return this;
};

// Taken from SO https://stackoverflow.com/questions/30043773/knockout-input-readonly-state/30101073#30101073
// User Yvan https://stackoverflow.com/users/3738129/yvan
// Adjusted to add disabled attrbute, not enabled
ko.bindingHandlers.disabled = {
    update: function (element, valueAccessor) {
        if (ko.utils.unwrapObservable(valueAccessor())) {
            element.setAttribute('disabled', true);
        } else {
            element.removeAttribute('disabled');
        }
    }
};
ko.bindingHandlers.title = {
    update: function (element, valueAccessor) {
        var value = ko.utils.unwrapObservable(valueAccessor());
        if (value) {
            element.setAttribute('title', value);
        } else {
            element.removeAttribute('title');
        }
    }
}

var loadClubCompetition = function (key, dateString) {
    var comp = CLUB_COMPETITIONS[key];
    viewModel.isClubMode(true);
    viewModel.rankingsSource(key);

    var stored = localStorage.getItem('wr-calc-seeds-' + key);
    var seedData = null;
    if (stored) {
        try { seedData = JSON.parse(stored); } catch (e) { seedData = null; }
    }

    if (!seedData || !seedData.seeds || seedData.seeds.length === 0) {
        viewModel.competitionLabel(comp.label);
        viewModel.seedsRequired(true);
        return;
    }

    var rankings = {};
    var sorted = [];
    var maxLength = 15;
    $.each(seedData.seeds, function (i, seed) {
        var team = {
            id: String(comp.baseId + i),
            name: seed.name,
            abbreviation: seed.abbreviation,
            displayName: seed.name.length > maxLength ? seed.abbreviation : seed.name,
            displayTitle: seed.name.length > maxLength ? seed.name : null
        };
        var entry = { team: team, pts: parseFloat(seed.pts), pos: i + 1 };
        var rv = new RankingViewModel(entry);
        viewModel.teams.push(team);
        rankings[team.id] = rv;
        sorted.push(rv);
    });

    viewModel.rankingsById(rankings);
    viewModel.baseRankings(sorted);
    viewModel.originalDate(dateString || seedData.seedDate);
    viewModel.originalMillis = new Date(dateString || seedData.seedDate).getTime();
    viewModel.rankingsChoice('original');

    if (fixturesString) {
        viewModel.fixturesString(fixturesString);
        viewModel.rankingsChoice('calculated');
        viewModel.queryString.subscribe(function (qs) {
            history.replaceState(null, '', '?' + qs);
        });
    } else if (comp.matchApiBase) {
        loadClubFixtures(comp, rankings);
    } else {
        addFixture();
        viewModel.queryString.subscribe(function (qs) {
            history.replaceState(null, '', '?' + qs);
        });
    }
};

var saveSeedsFromUI = function (key) {
    var seedDate = document.getElementById('seed-date').value.trim();
    var csv = document.getElementById('seed-csv').value.trim();

    if (!seedDate) { alert('Please enter a seed date.'); return; }
    if (!csv) { alert('Please enter at least one team.'); return; }

    var seeds = [];
    var errors = [];
    $.each(csv.split('\n'), function (i, line) {
        line = line.trim();
        if (!line) return;
        var parts = line.split(',');
        if (parts.length < 3) { errors.push('Line ' + (i + 1) + ': need Name, Abbreviation, Points'); return; }
        var name = parts[0].trim();
        var abbr = parts[1].trim();
        var pts  = parseFloat(parts[2].trim());
        if (!name || !abbr || isNaN(pts)) { errors.push('Line ' + (i + 1) + ': invalid data'); return; }
        seeds.push({ name: name, abbreviation: abbr, pts: pts });
    });

    if (errors.length > 0) { alert(errors.join('\n')); return; }
    if (seeds.length === 0) { alert('No valid team data found.'); return; }

    localStorage.setItem('wr-calc-seeds-' + key, JSON.stringify({ seedDate: seedDate, seeds: seeds }));

    viewModel.seedsRequired(false);
    viewModel.teams([]);
    viewModel.fixtures([]);
    loadClubCompetition(key, null);
};

var loadClubFixtures = function (comp, rankings) {
    var rankingDate = new Date(viewModel.originalDate());
    var from = formatDate(rankingDate);
    var to = formatDate(rankingDate.addDays(14));

    var url = comp.matchApiBase + '/match?startDate=' + from + '&endDate=' + to + '&sort=asc&pageSize=100&page=';
    if (comp.matchApiParams) {
        url += '&' + $.param(comp.matchApiParams);
    }

    var getFixtures = function (fixtures, page, then) {
        $.get(url + page).done(function (data) {
            var content = data.content || [];
            if (content.length === 100) {
                getFixtures(fixtures.concat(content), page + 1, then);
            } else {
                then(fixtures.concat(content));
            }
        }).fail(function () {
            addFixture();
            viewModel.queryString.subscribe(function (qs) {
                history.replaceState(null, '', '?' + qs);
            });
        });
    };

    getFixtures([], 0, function (fixtures) {
        fixturesLoadedClub(fixtures, rankings, comp);
    });
};

var fixturesLoadedClub = function (fixtures, rankings, comp) {
    fixtures.reverse();

    $.each(fixtures, function (i, e) {
        var raw = (comp.normalizeMatch ? comp.normalizeMatch(e) : e);
        if (!raw.teams || !raw.teams[0] || !raw.teams[1]) return;
        if (!rankings[raw.teams[0].id] || !rankings[raw.teams[1].id]) return;

        addFixture(true, function (fixture) {
            fixture.homeId(raw.teams[0].id);
            fixture.awayId(raw.teams[1].id);
            fixture.isRwc(false);

            if (raw.time) {
                fixture.kickoff = $.formatDateTime('D dd/mm/yy hh:ii', new Date(raw.time.millis));
            }
            if (raw.venue) {
                fixture.venueNameAndCountry = [raw.venue.name, raw.venue.country].join(', ');
                fixture.venueCity = raw.venue.city;
            }

            if (comp.homeAdvantageMode === 'none') {
                fixture.noHome(true);
                fixture.switched(false);
            } else {
                fixture.noHome(false);
                fixture.switched(false);
            }

            if (raw.status && raw.status !== 'U' && raw.status !== 'UP' && raw.status !== 'CC') {
                fixture.homeScore(raw.scores[0]);
                fixture.awayScore(raw.scores[1]);
            }
            switch (raw.status) {
                case 'U': {
                    var leeway = 5 * 60 * 1000;
                    fixture.liveScoreMode = (raw.time.millis + leeway > new Date()) ? 'Upcoming' : 'Unreported';
                    break;
                }
                case 'UP':  fixture.liveScoreMode = 'Postponed'; break;
                case 'CC':  fixture.liveScoreMode = 'Cancelled'; break;
                case 'C': {
                    fixture.liveScoreMode = 'Complete';
                    if (raw.time.millis + 90 * 60 * 1000 < viewModel.originalMillis) {
                        fixture.alreadyInRankings = true;
                    }
                    break;
                }
                case 'L1':  fixture.liveScoreMode = 'First half'; break;
                case 'L2':  fixture.liveScoreMode = 'Second half'; break;
                case 'LHT': fixture.liveScoreMode = 'Half time'; break;
            }
        });
    });

    viewModel.queryString.subscribe(function (qs) {
        history.replaceState(null, '', '?' + qs);
    });
};

var loadCombined = function (dateString) {
    viewModel.isClubMode(true);
    viewModel.rankingsSource('mru');

    var maxLength = 15;
    $.get('https://api.wr-rims-prod.pulselive.com/rugby/v3/rankings/mru' + (dateString ? ('?date=' + dateString) : '')).done(function (data) {
        var rankings = {};

        $.each(data.entries, function (i, e) {
            e.team.displayName = e.team.name.length > maxLength ? e.team.abbreviation : e.team.name;
            e.team.displayTitle = e.team.name.length > maxLength ? e.team.name : null;
            viewModel.teams.push(e.team);
            rankings[e.team.id] = new RankingViewModel(e);
        });

        $.each(CLUB_COMPETITIONS, function (key, comp) {
            var stored = localStorage.getItem('wr-calc-seeds-' + key);
            if (!stored) return;
            var seedData;
            try { seedData = JSON.parse(stored); } catch (e) { return; }
            if (!seedData || !seedData.seeds) return;

            $.each(seedData.seeds, function (j, seed) {
                var team = {
                    id: String(comp.baseId + j),
                    name: seed.name,
                    abbreviation: seed.abbreviation,
                    displayName: seed.name.length > maxLength ? seed.abbreviation : seed.name,
                    displayTitle: seed.name.length > maxLength ? seed.name : null
                };
                var entry = { team: team, pts: parseFloat(seed.pts), pos: 0 };
                var rv = new RankingViewModel(entry);
                viewModel.teams.push(team);
                rankings[team.id] = rv;
            });
        });

        viewModel.rankingsById(rankings);

        var sorted = [];
        $.each(rankings, function (id, rv) { sorted.push(rv); });
        sorted.sort(function (a, b) { return b.pts() - a.pts(); });
        $.each(sorted, function (i, r) { r.pos(i + 1); });
        viewModel.baseRankings(sorted);

        viewModel.originalDate(data.effective.label);
        viewModel.originalMillis = data.effective.millis;
        viewModel.rankingsChoice('original');

        if (data.effective.label > dateString) {
            viewModel.originalDate(dateString);
            viewModel.originalMillis = new Date(dateString).getTime();
            viewModel.originalDateIsEstimated(true);
        }

        if (fixturesString) {
            viewModel.fixturesString(fixturesString);
            viewModel.rankingsChoice('calculated');
            viewModel.queryString.subscribe(function (qs) {
                history.replaceState(null, '', '?' + qs);
            });
        } else {
            addFixture();
            loadFixtures(rankings, !!dateString);
        }
    });
};

if (sourceString == 'mru' || sourceString == 'wru') {
    loadRankings(sourceString, dateString);
} else if (sourceString == 'all') {
    loadCombined(dateString);
} else if (CLUB_COMPETITIONS[sourceString]) {
    loadClubCompetition(sourceString, dateString);
} else {
    // load the event!
    $.get('https://api.wr-rims-prod.pulselive.com/rugby/v3/event/' + sourceString + '/schedule?language=en').done(function (data) {

        loadRankings(
            data.event.sport,
            data.event.start.label,// maybe subtract a day so we don't include rankings on that date?
            data.matches,
            data.event
        );
    });
}
